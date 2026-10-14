import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { ATTR, canonical, hash, renderNote } from '../src/core.js';
import {
  syncBoth,
  syncReadOnly,
  createFromBlock,
  resolveCloudConflict,
  emptyState,
} from '../src/bidirectional.js';
import { mergeContent, mergeNoteData, stableJson } from '../../shared/noteMerge.js';
import { canonicalHtml } from '../../shared/noteSchema.js';
import { Webdav, byteHash } from '../src/webdav.js';
const window = new JSDOM('').window;
for (const key of ['window', 'document', 'DOMParser', 'Node', 'HTMLElement', 'Element'])
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true });

test('JS与Rust共用正文合并用例，互换双方顺序仍得到相同结果', async () => {
  const fixtures = JSON.parse(
    await readFile(new URL('../../shared/merge-fixtures.json', import.meta.url), 'utf8')
  );
  for (const f of fixtures) {
    assert.equal(mergeContent(f.base, f.local, f.remote), f.expected, f.name);
    assert.equal(mergeContent(f.base, f.remote, f.local), f.expected, f.name);
  }
  assert.deepEqual(
    mergeNoteData(
      { title: '甲', content: '<p>乙</p>' },
      { title: '新甲', content: '<p>乙</p>' },
      { title: '甲', content: '<p>新乙</p>' }
    ),
    { title: '新甲', content: '<p>新乙</p>' }
  );
});
function fixture() {
  const uuid = randomUUID(),
    space = randomUUID(),
    revision = randomUUID(),
    id = '20261014120000-abcdefg',
    documentId = '20261014120000-doc0001';
  const data = {
    title: '便签',
    content: '<p>甲</p><p>乙</p>',
    color: 'default',
    is_pinned: false,
    is_completed: false,
    created_at: '2026-10-14T00:00:00.000Z',
    updated_at: '2026-10-14T00:00:00.000Z',
  };
  const records = {
    [uuid]: { revision, deleted: false, updated_at: Date.parse(data.updated_at), data },
  };
  const doc = {
    schema_version: 3,
    space_id: space,
    generation: 1,
    records,
    note_assets: {},
    note_conflicts: {},
  };
  const files = new Map(),
    etags = new Map(),
    blocks = new Map(),
    calls = [],
    uploaded = new Map();
  let sequence = 0,
    failAttrs = false,
    stale = false,
    saved = null;
  const put = (path, bytes) => {
    files.set(path, bytes);
    etags.set(path, '"' + ++sequence + '"');
  };
  put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  put('clipboard.json', new TextEncoder().encode(JSON.stringify({ policy: { total_mib: 500 } })));
  const escape = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const current = () => JSON.parse(new TextDecoder().decode(files.get('notes.json')));
  const kram = (block) =>
    `{{{\n${block.title}\n\n${block.content}\n${block.math ? '$bad$' : ''}\n}}}\n{: ${Object.entries(
      block.attrs
    )
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ')}}`;
  const dom = (key, block) =>
    `<div data-node-id="${key}" data-type="NodeSuperBlock"><div data-node-id="20261014120000-title01" data-type="NodeHeading" custom-pastepaw-part="title"><div contenteditable="true">${escape(block.title)}</div></div><div data-node-id="20261014120000-info001" data-type="NodeParagraph" custom-pastepaw-part="info"><div contenteditable="true">创建：${data.created_at} · 更新：${data.updated_at}</div></div><div data-node-id="20261014120000-body001" data-type="${block.math ? 'NodeMathBlock' : 'NodeParagraph'}" data-html="${escape(block.content)}"></div></div>`;
  const convert = (html) => {
    const doc = new window.DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('[data-html]')]
      .map((el) => el.getAttribute('data-html'))
      .join('');
  };
  const headers = () => ({ Date: [new Date().toUTCString()] });
  const api = async (path, args) => {
    if (path === '/api/network/forwardProxy') {
      const resource = new URL(args.url).pathname.split('/v1/')[1],
        method = args.method;
      calls.push({ resource, method });
      const requestHeaders = args.headers[0];
      if (method === 'MKCOL') return { status: 201, body: '', headers: headers() };
      if (method === 'GET')
        return {
          status: files.has(resource) ? 200 : 404,
          body: files.has(resource)
            ? args.responseEncoding === 'base64'
              ? Buffer.from(files.get(resource)).toString('base64')
              : new TextDecoder().decode(files.get(resource))
            : '',
          headers: { ...headers(), ETag: [etags.get(resource)] },
        };
      if (method === 'PUT') {
        if (stale && resource === 'notes.json') {
          stale = false;
          const doc = current();
          doc.records[uuid].revision = randomUUID();
          doc.records[uuid].data.content = '<p>并发修改</p>';
          put(resource, new TextEncoder().encode(JSON.stringify(doc)));
        }
        if (
          (requestHeaders['If-None-Match'] === '*' && files.has(resource)) ||
          (requestHeaders['If-Match'] && requestHeaders['If-Match'] !== etags.get(resource))
        )
          return { status: 412, body: '', headers: headers() };
        put(resource, new Uint8Array(Buffer.from(args.payload, 'base64')));
        return { status: 201, body: '', headers: headers() };
      }
      if (method === 'DELETE') {
        if (requestHeaders['If-Match'] !== etags.get(resource))
          return { status: 412, body: '', headers: headers() };
        files.delete(resource);
        return { status: 204, body: '', headers: headers() };
      }
      if (method === 'PROPFIND')
        return {
          status: 207,
          body:
            '<d:multistatus xmlns:d="DAV:">' +
            [...files]
              .filter(([name]) => (resource ? name.startsWith(resource) : !name.includes('/')))
              .map(
                ([name, bytes]) =>
                  `<d:response><d:href>/dav/pastepaw/v1/${name}</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${bytes.length}</d:getcontentlength></d:prop></d:propstat></d:response>`
              )
              .join('') +
            '</d:multistatus>',
          headers: headers(),
        };
      throw new Error('未知代理方法');
    }
    if (path === '/api/sqlite/flushTransaction') return null;
    if (path === '/api/asset/upload') {
      const file = args.get('file[]'),
        path = 'assets/' + file.name;
      uploaded.set(file.name.slice(0, 12), path);
      return { succMap: { [file.name]: path } };
    }
    if (path === '/api/query/sql')
      return [...blocks]
        .filter(([, b]) => b.attrs[ATTR.key])
        .map(([key, b]) => ({ id: key, source_key: b.attrs[ATTR.key] }));
    if (path === '/api/attr/getBlockAttrs')
      return args.id === documentId ? { type: 'doc' } : { ...blocks.get(args.id)?.attrs };
    if (path === '/api/block/getBlockKramdown') return { kramdown: kram(blocks.get(args.id)) };
    if (path === '/api/block/getBlockDOM') return { dom: dom(args.id, blocks.get(args.id)) };
    if (path === '/api/attr/setBlockAttrs') {
      if (failAttrs) {
        failAttrs = false;
        throw new Error('模拟标记保存失败');
      }
      Object.assign(blocks.get(args.id).attrs, args.attrs);
      return null;
    }
    if (path === '/api/block/appendBlock' || path === '/api/block/updateBlock') {
      const key = path.endsWith('appendBlock')
        ? '20261014120000-' + (++sequence).toString(36).padStart(7, '0')
        : args.id;
      const source = args.data.match(/custom-pastepaw-key="([^\"]+)"/)[1].split(':')[1],
        record = current().records[source];
      if (record.deleted) {
        blocks.get(key).content += '\n来源便签已删除';
        return [{ doOperations: [{ action: 'update', id: key }] }];
      }
      const body = record.data.content.replace(
        /pastepaw-asset:([a-f0-9]{64})/g,
        (_, hash) => uploaded.get(hash.slice(0, 12)) || 'assets/fixture.png'
      );
      blocks.set(key, {
        title: record.data.title || '未命名便签',
        content: body,
        attrs: {
          [ATTR.key]: `${space}:${source}`,
          [ATTR.revision]: record.revision,
          [ATTR.state]: 'pending',
        },
      });
      return [{ doOperations: [{ action: 'insert', id: key }] }];
    }
    throw new Error('未知思源接口 ' + path);
  };
  const state = emptyState();
  state.space_id = space;
  const setup = async () => {
    const block = {
      title: data.title,
      content: data.content,
      attrs: { [ATTR.key]: `${space}:${uuid}`, [ATTR.revision]: revision, [ATTR.state]: 'active' },
    };
    block.attrs[ATTR.hash] = await hash(canonical(kram(block)));
    blocks.set(id, block);
    state.bindings[uuid] = {
      id,
      revision,
      data: structuredClone(data),
      display: { title: data.title, content: canonicalHtml(data.content) },
      hash: block.attrs[ATTR.hash],
    };
  };
  const options = {
    credentials: {
      endpoint: 'http://example.invalid/dav/',
      directory: 'pastepaw',
      username: 'fixture-user',
      password: 'fixture-password',
    },
    api,
    documentId,
    state,
    convert,
    readAsset: async () => new Uint8Array([137, 80, 78, 71, 1]),
    saveState: async (s) => {
      saved = structuredClone(s);
    },
  };
  return {
    uuid,
    id,
    space,
    doc,
    data,
    state,
    options,
    files,
    blocks,
    calls,
    setup,
    current,
    put,
    failAttrs: () => {
      failAttrs = true;
    },
    stale: () => {
      stale = true;
    },
    saved: () => saved,
  };
}
test('思源单独改正文能回传，默认单向模式没有WebDAV写入', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>思源编辑</p>';
  const result = await syncBoth(f.options);
  assert.equal(result.uploaded, 1);
  assert.equal(f.current().records[f.uuid].data.content, '<p>思源编辑</p>');
  const g = fixture();
  await g.setup();
  await syncReadOnly(g.options);
  assert.ok(g.calls.every((call) => call.method === 'GET'));
});
test('便签改正文、思源改标题自动合并并把完整结果更新回思源', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).title = '手机标题';
  const doc = f.current();
  doc.records[f.uuid].data.content = '<p>电脑正文</p>';
  doc.records[f.uuid].revision = randomUUID();
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  const result = await syncBoth(f.options);
  assert.equal(result.merged, 1);
  assert.equal(f.current().records[f.uuid].data.title, '手机标题');
  assert.equal(f.current().records[f.uuid].data.content, '<p>电脑正文</p>');
  assert.equal(f.blocks.get(f.id).content, '<p>电脑正文</p>');
});
test('正文重叠修改保留两版本，思源原区域改绑到副本，重试不制造额外副本', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>手机版本</p>';
  const doc = f.current();
  doc.records[f.uuid].data.content = '<p>电脑版本</p>';
  doc.records[f.uuid].revision = randomUUID();
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  await syncBoth(f.options);
  const first = f.current(),
    conflict = Object.values(first.note_conflicts)[0];
  assert.equal(Object.keys(first.records).length, 2);
  assert.equal(f.blocks.get(f.id).attrs[ATTR.key], `${f.space}:${conflict.copy_uuid}`);
  assert.ok(f.blocks.get(f.id).content.includes('手机版本'));
  await syncBoth(f.options);
  assert.equal(Object.keys(f.current().records).length, 2);
  await resolveCloudConflict(f.options, {
    id: conflict.copy_uuid,
    choice: 'keep_other',
    original: stableJson(first.records[conflict.original_uuid]),
    other: stableJson(first.records[conflict.copy_uuid]),
  });
  assert.ok(f.current().note_conflicts[conflict.copy_uuid].resolved);
  assert.equal(f.current().records[f.uuid].data.content, '<p>手机版本</p>');
});
test('删除思源区域只解除绑定，不删除云端便签或重新插入区域', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.delete(f.id);
  await syncBoth(f.options);
  assert.ok(f.state.detached[f.uuid]);
  assert.ok(f.current().records[f.uuid].data);
  assert.equal(f.blocks.size, 0);
});
test('不支持的思源块保留本地修改，云端另一版也保留', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).math = true;
  const doc = f.current();
  doc.records[f.uuid].data.content = '<p>另一端新内容</p>';
  doc.records[f.uuid].revision = randomUUID();
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  const result = await syncBoth(f.options);
  assert.ok(result.unsupported.length);
  assert.equal(f.current().records[f.uuid].data.content, '<p>另一端新内容</p>');
  assert.ok(f.blocks.get(f.id).math);
});

test('冲突改绑失败的重试恢复原区域，不重复插入或覆盖未回传的新编辑', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>手机冲突</p>';
  const doc = f.current();
  doc.records[f.uuid].data.content = '<p>电脑冲突</p>';
  doc.records[f.uuid].revision = randomUUID();
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  f.failAttrs();
  await assert.rejects(() => syncBoth(f.options), /保存失败/);
  Object.assign(f.state, structuredClone(f.saved()));
  f.blocks.get(f.id).content = '<p>手机冲突后继续编辑</p>';
  await syncBoth(f.options);
  const conflict = Object.values(f.current().note_conflicts)[0];
  assert.equal(Object.keys(f.current().records).length, 2);
  assert.equal(f.blocks.get(f.id).attrs[ATTR.key], `${f.space}:${conflict.copy_uuid}`);
  assert.equal(f.current().records[conflict.copy_uuid].data.content, '<p>手机冲突后继续编辑</p>');
});

test('发布后立刻编辑不会误记为已同步，下轮仍能回传', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>第一轮</p>';
  const api = f.options.api;
  let flushes = 0;
  f.options.api = async (path, args) => {
    const result = await api(path, args);
    if (path === '/api/sqlite/flushTransaction' && ++flushes === 2)
      f.blocks.get(f.id).content = '<p>第二轮</p>';
    return result;
  };
  await syncBoth(f.options);
  assert.equal(f.current().records[f.uuid].data.content, '<p>第一轮</p>');
  assert.equal(f.blocks.get(f.id).content, '<p>第二轮</p>');
  await syncBoth(f.options);
  assert.equal(f.current().records[f.uuid].data.content, '<p>第二轮</p>');
});

test('解决冲突后再同步会更新主区域并归档副本，旧版本不会重新出现', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>手机</p>';
  const doc = f.current();
  doc.records[f.uuid].data.content = '<p>电脑</p>';
  doc.records[f.uuid].revision = randomUUID();
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  await syncBoth(f.options);
  const current = f.current(),
    conflict = Object.values(current.note_conflicts)[0];
  await resolveCloudConflict(f.options, {
    id: conflict.copy_uuid,
    choice: 'keep_other',
    original: stableJson(current.records[f.uuid]),
    other: stableJson(current.records[conflict.copy_uuid]),
  });
  await syncBoth(f.options);
  assert.equal(f.current().records[f.uuid].data.content, '<p>手机</p>');
  assert.ok(f.state.detached[conflict.copy_uuid]);
  assert.ok(f.blocks.get(f.id).content.includes('来源便签已删除'));
  assert.equal(Object.values(f.current().note_conflicts).filter((c) => !c.resolved).length, 0);
});

test('同步锁、条件写和云端总额度均能阻止不安全的回传', async () => {
  const locked = fixture();
  await locked.setup();
  locked.blocks.get(locked.id).title = '手机';
  locked.put(
    'lease.json',
    new TextEncoder().encode(
      JSON.stringify({ owner: randomUUID(), expires_at: Date.now() + 120000 })
    )
  );
  await assert.rejects(() => syncBoth(locked.options), /正在同步/);
  assert.equal(locked.current().records[locked.uuid].data.title, '便签');
  const unsafe = fixture();
  await unsafe.setup();
  const api = unsafe.options.api;
  unsafe.options.api = async (path, args) => {
    if (
      path === '/api/network/forwardProxy' &&
      args.method === 'PUT' &&
      args.headers[0]['If-Match'] === '"pastepaw-invalid-etag"'
    )
      return { status: 200, body: '', headers: { Date: [new Date().toUTCString()] } };
    return api(path, args);
  };
  await assert.rejects(() => syncBoth(unsafe.options), /忽略了版本校验/);
  assert.ok(!unsafe.calls.some((c) => c.method === 'PUT' && c.resource === 'notes.json'));
  const full = fixture();
  await full.setup();
  full.blocks.get(full.id).title = '手机';
  full.put(
    'clipboard.json',
    new TextEncoder().encode(JSON.stringify({ policy: { total_mib: 10 } }))
  );
  full.put('orphan.bin', new Uint8Array(11 * 1024 * 1024));
  await assert.rejects(() => syncBoth(full.options), /总容量不足/);
  assert.equal(full.current().records[full.uuid].data.title, '便签');
  assert.equal(full.blocks.get(full.id).title, '手机');
});

test('Apache短暂弱ETag重新读取后可继续，二进制写入后的篡改会被拒绝', async () => {
  const f = fixture();
  const api = f.options.api;
  let weak = true,
    tamper = false;
  const proxy = async (path, args) => {
    const result = await api(path, args);
    if (args.method === 'GET' && weak) {
      weak = false;
      result.headers.ETag = ['W/"temporary"'];
    }
    if (tamper && args.method === 'GET' && args.responseEncoding === 'base64')
      result.body = Buffer.from([1, 2, 3]).toString('base64');
    return result;
  };
  const bridge = new Webdav(f.options.credentials, proxy);
  const file = await bridge.get('notes.json');
  assert.ok(file.etag);
  tamper = true;
  await assert.rejects(
    () => bridge.put(`note-assets/${'a'.repeat(64)}.bin`, new Uint8Array([1, 2, 4])),
    /内容校验失败/
  );
});

test('新电脑附件拉取后保存正确路径基线，随后思源改标题不会重新上传图片', async () => {
  const f = fixture();
  await f.setup();
  const bytes = new Uint8Array([137, 80, 78, 71, 1]),
    id = await byteHash(bytes),
    doc = f.current();
  doc.records[f.uuid].revision = randomUUID();
  doc.records[f.uuid].data.content =
    `<img src="pastepaw-asset:${id}" data-asset="${id}" data-name="图.png" data-mime="image/png" data-size="5">`;
  doc.note_assets[id] = { hash: id, name: '图.png', mime: 'image/png', size: 5 };
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  f.put(`note-assets/${id}.bin`, bytes);
  await syncBoth(f.options);
  assert.ok(
    Object.entries(f.state.asset_paths).some(
      ([path, asset]) => path.startsWith('assets/') && asset.hash === id
    )
  );
  f.blocks.get(f.id).title = '带图的新标题';
  const count = f.calls.filter(
    (c) => c.method === 'PUT' && c.resource.startsWith('note-assets/')
  ).length;
  await syncBoth(f.options);
  assert.equal(f.current().records[f.uuid].data.title, '带图的新标题');
  assert.equal(
    f.calls.filter((c) => c.method === 'PUT' && c.resource.startsWith('note-assets/')).length,
    count
  );
});

test('冲突决策拒绝云端或思源已变化的旧比较，手动合并可上传当前区域', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>手机</p>';
  const doc = f.current();
  doc.records[f.uuid].revision = randomUUID();
  doc.records[f.uuid].data.content = '<p>电脑</p>';
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  await syncBoth(f.options);
  const current = f.current(),
    conflict = Object.values(current.note_conflicts)[0],
    input = {
      id: conflict.copy_uuid,
      choice: 'keep_original',
      original: stableJson(current.records[f.uuid]),
      other: stableJson(current.records[conflict.copy_uuid]),
    };
  f.blocks.get(f.id).content = '<p>手工合并电脑和手机</p>';
  await assert.rejects(() => resolveCloudConflict(f.options, input), /未回传编辑/);
  f.failAttrs();
  await assert.rejects(
    () =>
      resolveCloudConflict(f.options, {
        ...input,
        choice: 'merge',
        source_uuid: conflict.copy_uuid,
      }),
    /保存失败/
  );
  assert.equal(f.current().records[f.uuid].data.content, '<p>手工合并电脑和手机</p>');
  Object.assign(f.state, structuredClone(f.saved()));
  await syncBoth(f.options);
  assert.equal(Object.keys(f.current().records).length, 2);
  assert.equal(Object.values(f.current().note_conflicts).filter((c) => !c.resolved).length, 0);
  await assert.rejects(() => resolveCloudConflict(f.options, input), /已经处理/);
});

test('常用列表、代码空白和表格经思源HTML规范化仍可保存为便签结构', () => {
  const html =
    '<ul><li><input type="checkbox" checked><p>待办</p><ol start="3"><li><p>子列表</p></li></ol></li><li><p>普通项</p></li></ul><pre><code class="language-javascript">  const x = 1;\n\n  x++;\n</code></pre><table><tbody><tr><th>甲</th><td>乙</td></tr></tbody></table>';
  const canonical = canonicalHtml(html);
  assert.match(canonical, /data-type="taskList"/);
  assert.match(canonical, /data-checked="true"/);
  assert.match(canonical, /<ol start="3">/);
  assert.match(canonical, /  const x = 1;\n\n  x\+\+;\n/);
  assert.match(canonical, /<table\b/);
  assert.equal(canonicalHtml(canonical), canonical);
});
test('附件回传校验大小和哈希并去重，条件写失败不覆盖并发修改', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p><img src="assets/截图.png" alt="截图"></p>';
  await syncBoth(f.options);
  const assets = f.current().note_assets;
  assert.equal(Object.keys(assets).length, 1);
  assert.ok(f.files.has(`note-assets/${Object.keys(assets)[0]}.bin`));
  const g = fixture();
  await g.setup();
  g.blocks.get(g.id).content = '<p>手机编辑</p>';
  g.stale();
  await assert.rejects(() => syncBoth(g.options), /已变化|同步/);
  assert.equal(g.current().records[g.uuid].data.content, '<p>并发修改</p>');
  assert.equal(g.blocks.get(g.id).content, '<p>手机编辑</p>');
});
test('云端提交后标记失败可重试，不丢失思源内容或增加重复版本', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>保留修改</p>';
  f.failAttrs();
  await assert.rejects(() => syncBoth(f.options), /保存失败/);
  assert.equal(f.current().records[f.uuid].data.content, '<p>保留修改</p>');
  Object.assign(f.state, structuredClone(f.saved()));
  await syncBoth(f.options);
  assert.equal(Object.keys(f.current().records).length, 1);
  assert.equal(f.blocks.get(f.id).content, '<p>保留修改</p>');
});
test('来源删除与思源编辑冲突仍保留修改，创建普通块不会把其他文档内容抓取进去', async () => {
  const f = fixture();
  await f.setup();
  f.blocks.get(f.id).content = '<p>删除期间编辑</p>';
  const doc = f.current();
  doc.records[f.uuid] = {
    revision: randomUUID(),
    deleted: true,
    updated_at: Date.now(),
    data: null,
  };
  f.put('notes.json', new TextEncoder().encode(JSON.stringify(doc)));
  await syncBoth(f.options);
  assert.ok(f.current().records[f.uuid].deleted);
  assert.ok(
    Object.values(f.current().records).some((r) => r.data?.content === '<p>删除期间编辑</p>')
  );
  const g = fixture();
  await g.setup();
  const newId = '20261014120000-new0001';
  g.blocks.set(newId, { title: '普通块', content: '<p>新内容</p>', attrs: {} });
  const created = await createFromBlock(g.options, newId);
  assert.equal(g.current().records[created.uuid].data.content, '<p>新内容</p>');
  assert.equal(g.blocks.get(newId).content, '<p>新内容</p>');
  await assert.rejects(() => createFromBlock(g.options, newId), /已经创建/);
});
