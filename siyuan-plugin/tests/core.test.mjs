import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  ATTR,
  canonical,
  decryptVault,
  encryptVault,
  hash,
  importNotes,
  loadNotes,
  rootUrl,
} from '../src/core.js';

function sample() {
  const uuid = randomUUID();
  return {
    uuid,
    document: {
      schema_version: 1,
      space_id: randomUUID(),
      generation: 1,
      records: {
        [uuid]: {
          revision: randomUUID(),
          deleted: false,
          updated_at: Date.now(),
          data: {
            title: '中文便签',
            content: '<p>原始正文</p>',
            color: 'default',
            is_pinned: false,
            is_completed: false,
            created_at: '2026-10-13T00:00:00+00:00',
            updated_at: '2026-10-13T00:00:00+00:00',
          },
        },
      },
    },
  };
}

function kernel() {
  const documentId = '20261013120000-abcdefg';
  const blocks = new Map();
  let sequence = 0;
  let failAfterInsert = false;
  const attrsFrom = (data) =>
    Object.fromEntries(
      [...data.matchAll(/(custom-pastepaw-[\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])
    );
  const api = async (path, data) => {
    if (path === '/api/attr/getBlockAttrs')
      return data.id === documentId ? { type: 'doc' } : { ...blocks.get(data.id).attrs };
    if (path === '/api/query/sql')
      return [...blocks].map(([id, block]) => ({ id, source_key: block.attrs[ATTR.key] }));
    if (path === '/api/block/appendBlock') {
      const id = '20261013120000-' + (++sequence).toString(36).padStart(7, '0');
      blocks.set(id, { text: data.data, attrs: attrsFrom(data.data) });
      if (failAfterInsert) {
        failAfterInsert = false;
        throw new Error('模拟上传成功后断网');
      }
      return [{ doOperations: [{ action: 'insert', id }] }];
    }
    if (path === '/api/block/getBlockKramdown') {
      const block = blocks.get(data.id);
      return {
        kramdown:
          block.text +
          '\n{: id="' +
          data.id +
          '" updated="20261013120000" ' +
          Object.entries(block.attrs)
            .map(([key, value]) => `${key}="${value}"`)
            .join(' ') +
          '}',
      };
    }
    if (path === '/api/block/updateBlock') {
      const block = blocks.get(data.id);
      block.text = data.data;
      block.attrs = { ...block.attrs, ...attrsFrom(data.data) };
      return [];
    }
    if (path === '/api/attr/setBlockAttrs') {
      Object.assign(blocks.get(data.id).attrs, data.attrs);
      return null;
    }
    throw new Error('未预期的测试接口');
  };
  return {
    documentId,
    blocks,
    api,
    failNextInsert() {
      failAfterInsert = true;
    },
  };
}

test('凭据加密不含明文，错误密码和篡改文件均无法解锁', async () => {
  const credentials = {
    endpoint: 'https://example.invalid/dav/',
    directory: 'pastepaw',
    username: 'fixture-user',
    password: 'fixture-password',
  };
  const vault = await encryptVault(credentials, 'fixture-unlock-password');
  for (const secret of [credentials.endpoint, credentials.username, credentials.password])
    assert.ok(!JSON.stringify(vault).includes(secret));
  assert.deepEqual(await decryptVault(vault, 'fixture-unlock-password'), credentials);
  await assert.rejects(decryptVault(vault, 'incorrect-password'));
  await assert.rejects(
    decryptVault(
      { ...vault, ciphertext: vault.ciphertext.slice(0, -4) + 'AAAA' },
      'fixture-unlock-password'
    )
  );
  assert.throws(() => rootUrl({ ...credentials, directory: '../escape' }));
  assert.throws(() => rootUrl({ ...credentials, endpoint: 'https://u:p@example.invalid/' }));
});

test('允许远端 HTTP 地址和六字符解锁密码，保留协议及密码长度校验', async () => {
  const credentials = {
    endpoint: 'http://example.invalid/dav/',
    directory: 'pastepaw',
    username: 'fixture-user',
    password: 'fixture-password',
  };
  assert.equal(rootUrl(credentials).href, 'http://example.invalid/dav/pastepaw/v1/');
  await assert.rejects(encryptVault(credentials, '12345'));
  await assert.rejects(encryptVault(credentials, '🔑🔑🔑🔑🔑'));
  const vault = await encryptVault(credentials, '123456');
  assert.deepEqual(await decryptVault(vault, '123456'), credentials);
  assert.throws(() => rootUrl({ ...credentials, endpoint: 'ftp://example.invalid/dav/' }));
  assert.throws(() => rootUrl({ ...credentials, endpoint: 'http://u:p@example.invalid/dav/' }));
});

test('Windows 与手机共享文档标记，重复导入不会重复新增', async () => {
  const { document } = sample();
  const host = kernel();
  const first = await importNotes(document, host.documentId, host.api, () => '原始正文');
  const second = await importNotes(document, host.documentId, host.api, () => '原始正文');
  assert.equal(first.added, 1);
  assert.equal(second.skipped, 1);
  assert.equal(host.blocks.size, 1);
});

test('更新已有便签，手工编辑时保留内容并报告冲突', async () => {
  const { document, uuid } = sample();
  const host = kernel();
  await importNotes(document, host.documentId, host.api, () => '原始正文');
  document.records[uuid].revision = randomUUID();
  document.records[uuid].data.content = '<p>更新正文</p>';
  const updated = await importNotes(document, host.documentId, host.api, () => '更新正文');
  assert.equal(updated.updated, 1);
  const block = [...host.blocks.values()][0];
  block.text += '\n手工编辑';
  document.records[uuid].revision = randomUUID();
  const conflicted = await importNotes(document, host.documentId, host.api, () => '不应覆盖');
  assert.equal(conflicted.conflicts, 1);
  assert.ok(block.text.includes('手工编辑'));
  assert.ok(!block.text.includes('不应覆盖'));
});

test('来源删除只添加标记，不删除思源内容', async () => {
  const { document, uuid } = sample();
  const host = kernel();
  await importNotes(document, host.documentId, host.api, () => '需要保留的正文');
  document.records[uuid] = {
    ...document.records[uuid],
    revision: randomUUID(),
    deleted: true,
    data: null,
  };
  const result = await importNotes(document, host.documentId, host.api, () => '');
  assert.equal(result.archived, 1);
  assert.equal(host.blocks.size, 1);
  const block = [...host.blocks.values()][0];
  assert.ok(block.text.includes('需要保留的正文'));
  assert.ok(block.text.includes('来源便签已删除'));
  assert.equal((await importNotes(document, host.documentId, host.api, () => '')).skipped, 1);
});

test('插入后断网的重试识别已有标记，保留未完成区域', async () => {
  const { document } = sample();
  const host = kernel();
  host.failNextInsert();
  await assert.rejects(importNotes(document, host.documentId, host.api, () => '正文'));
  const result = await importNotes(document, host.documentId, host.api, () => '正文');
  assert.equal(host.blocks.size, 1);
  assert.equal(result.conflicts, 1);
});

test('跨端产生重复标记时跳过区域，不擅自删除副本', async () => {
  const { document } = sample();
  const host = kernel();
  await importNotes(document, host.documentId, host.api, () => '正文');
  const block = [...host.blocks.values()][0];
  host.blocks.set('20261013120000-zzzzzzz', structuredClone(block));
  const result = await importNotes(document, host.documentId, host.api, () => '正文');
  assert.equal(result.conflicts, 1);
  assert.equal(host.blocks.size, 2);
});

test('比较内容时排除思源易变 ID，保留代码块内的字面内容', async () => {
  assert.equal(
    await hash(canonical('正文\n{: id="a" updated="1" custom-pastepaw-hash="x"}')),
    await hash(canonical('正文\n{: id="b" updated="2" custom-pastepaw-hash="y"}'))
  );
  assert.notEqual(canonical('```\n{: id="a"}\n```'), canonical('```\n{: id="b"}\n```'));
});

test('插件只读取便签文件，坏数据在任何文档写入前被拒绝', async () => {
  const credentials = {
    endpoint: 'http://example.invalid/dav/',
    directory: 'pastepaw',
    username: 'fixture-user',
    password: 'fixture-password',
  };
  const { document } = sample();
  let requested;
  const loaded = await loadNotes(credentials, async (path, payload) => {
    requested = { path, payload };
    return { status: 200, body: JSON.stringify(document) };
  });
  assert.equal(requested.path, '/api/network/forwardProxy');
  assert.equal(requested.payload.url, 'http://example.invalid/dav/pastepaw/v1/notes.json');
  assert.equal(requested.payload.method, 'GET');
  assert.equal(requested.payload.redirect, false);
  assert.equal(loaded.space_id, document.space_id);
  const host = kernel();
  await assert.rejects(
    importNotes({ ...document, schema_version: 99 }, host.documentId, host.api, () => '正文')
  );
  assert.equal(host.blocks.size, 0);
});
