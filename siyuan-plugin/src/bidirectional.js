import { ATTR, BLOCK_ID, canonical, hash, importNotes, validateNotes, loadNotes } from './core.js';
import { Webdav, encodeJson } from './webdav.js';
import { assetConverter } from './assets.js';
import { readBoundNote, readNewNote } from './bridgeContent.js';
import { canonicalHtml } from '../../shared/noteSchema.js';
import { assetReferences, htmlToMarkdown } from '../../shared/noteMarkdown.js';
import { stableJson, revisionId, mergedRecord, mergeContent } from '../../shared/noteMerge.js';

const clone = (value) => JSON.parse(JSON.stringify(value));
export function emptyState() {
  return { version: 1, space_id: null, bindings: {}, detached: {}, asset_paths: {}, pending: {} };
}
export function validateState(state) {
  if (
    !state ||
    state.version !== 1 ||
    typeof state.bindings !== 'object' ||
    typeof state.detached !== 'object' ||
    typeof state.asset_paths !== 'object' ||
    typeof state.pending !== 'object'
  )
    throw new Error('同步基线损坏，请备份思源内容后重新绑定');
  for (const [uuid, binding] of Object.entries(state.bindings))
    if (
      !/^[a-f0-9-]{32,36}$/i.test(uuid) ||
      !BLOCK_ID.test(binding.id) ||
      !binding.data ||
      typeof binding.data.content !== 'string' ||
      typeof binding.data.title !== 'string' ||
      !binding.display ||
      typeof binding.display.content !== 'string' ||
      typeof binding.display.title !== 'string'
    )
      throw new Error('同步绑定记录损坏');
}
function baseRecord(binding) {
  return {
    revision: binding.revision,
    deleted: false,
    updated_at: Date.parse(binding.data.updated_at),
    data: binding.data,
  };
}
async function sourceRecord(uuid, binding, snapshot, remote) {
  const before = binding?.data || remote?.data;
  if (!before) throw new Error('缺少便签基线，不能安全回传');
  const data = clone(before),
    display = binding?.display;
  if (!display || snapshot.title !== display.title) data.title = snapshot.title;
  if (!display) data.content = snapshot.content;
  else if (snapshot.content !== display.content) {
    const body = mergeContent(display.content, snapshot.content, canonicalHtml(before.content));
    if (body === null)
      throw new Error('两端格式差异无法安全回传，思源内容已保留；可复制到普通块后创建新便签');
    data.content = body;
  }
  if (stableJson(data) === stableJson(before)) return binding ? baseRecord(binding) : remote;
  data.updated_at = new Date().toISOString();
  const revision = await revisionId(
    `siyuan:${uuid}:${binding?.revision || remote?.revision}:${stableJson({ ...data, updated_at: null })}`
  );
  return { revision, deleted: false, updated_at: Date.parse(data.updated_at), data };
}
async function integrate(document, uuid, base, local) {
  const remote = document.records[uuid];
  if (
    Object.values(document.note_conflicts || {}).some(
      (c) => c.original_uuid === uuid && c.revisions.includes(local.revision)
    )
  )
    return { kind: 'acknowledged', uuid };
  if (remote && stableJson(local.data) === stableJson(remote.data))
    return { kind: 'unchanged', uuid };
  if (!remote || (base && stableJson(base.data) === stableJson(remote.data))) {
    document.records[uuid] = local;
    return { kind: 'uploaded', uuid };
  }
  // 比较时使用相同的编辑器结构，HTML 属性顺序或光标段落不应制造冲突。
  let merged = null;
  if (base?.data && remote.data) {
    const normalize = (record) => ({
      ...record,
      data: { ...record.data, content: canonicalHtml(record.data.content) },
    });
    merged = await mergedRecord(normalize(base), normalize(local), normalize(remote));
  }
  if (merged) {
    document.records[uuid] = merged;
    return { kind: 'merged', uuid };
  }
  const revisions = [local.revision, remote.revision].sort(),
    copy = await revisionId(`conflict:${uuid}:${revisions.join(':')}`);
  document.records[copy] = {
    ...local,
    data: { ...local.data, title: (local.data.title || '便签') + '（同步冲突）' },
  };
  document.note_conflicts ||= {};
  document.note_conflicts[copy] = {
    original_uuid: uuid,
    copy_uuid: copy,
    revisions,
    other_title: local.data.title,
    base: base?.data || null,
    source: 'siyuan',
    resolved: false,
    resolution_revision: null,
  };
  return { kind: 'conflict', uuid: copy, original: uuid };
}
export async function boundIds(documentId, api, signal) {
  if (!BLOCK_ID.test(documentId)) throw new Error('目标文档ID无效');
  const rows = await api(
    '/api/query/sql',
    {
      stmt: `SELECT b.id,a.value AS source_key FROM blocks b JOIN attributes a ON a.block_id=b.id WHERE b.root_id='${documentId}' AND a.name='${ATTR.key}' ORDER BY b.id LIMIT 100000`,
    },
    signal
  );
  if (!Array.isArray(rows)) throw new Error('思源绑定索引读取失败');
  const result = new Map();
  for (const row of rows) {
    if (!BLOCK_ID.test(row.id) || typeof row.source_key !== 'string')
      throw new Error('思源绑定标记异常');
    const list = result.get(row.source_key) || [];
    list.push(row.id);
    result.set(row.source_key, list);
  }
  return result;
}
function budget(inventory, extra, total) {
  if ([...inventory.values()].reduce((sum, n) => sum + n, 0) + extra + 256 * 1024 > total)
    throw new Error('云端总容量不足，思源修改已保留；清理或在电脑完成同步后重试');
}
async function publish(bridge, lease, document, file, context, state, saveState) {
  document.schema_version = 3;
  document.note_assets ||= {};
  document.note_conflicts ||= {};
  document.generation = (document.generation || 0) + 1;
  const refs = new Set(
    Object.values(document.records)
      .filter((r) => r.data)
      .flatMap((r) => assetReferences(r.data.content))
  );
  for (const id of refs) {
    const pending = context.pending.get(id);
    if (pending) document.note_assets[id] = pending.asset;
  }
  for (const id of Object.keys(document.note_assets))
    if (!refs.has(id)) delete document.note_assets[id];
  validateNotes(document);
  const notes = encodeJson(document),
    backup = await bridge.get('notes-backup.json');
  const missing = [...refs].filter((id) => !context.inventory.has(`note-assets/${id}.bin`));
  const bytes = missing.reduce((sum, id) => sum + (context.pending.get(id)?.bytes.length || 0), 0);
  budget(context.inventory, bytes + file.bytes.length + notes.length, context.total);
  await saveState(state);
  for (const id of missing) {
    const pending = context.pending.get(id);
    if (!pending) throw new Error('回传附件缺失，内容保留');
    await bridge.renew(lease);
    await bridge.put(`note-assets/${id}.bin`, pending.bytes);
    context.inventory.set(`note-assets/${id}.bin`, pending.bytes.length);
  }
  await bridge.renew(lease);
  await bridge.put('notes-backup.json', file.bytes, backup?.etag);
  await bridge.renew(lease);
  await bridge.put('notes.json', notes, file.etag);
}
async function setup(options) {
  const { credentials, api, signal, state } = options;
  validateState(state);
  const bridge = new Webdav(credentials, api, signal);
  await bridge.initialize();
  await bridge.probe();
  const lease = await bridge.acquire();
  try {
    const { document, file } = await bridge.notes();
    if (state.space_id && state.space_id !== document.space_id)
      throw new Error('目标文档绑定了另一个同步空间，请使用新文档');
    state.space_id = document.space_id;
    const clip = await bridge.get('clipboard.json'),
      policy = clip ? JSON.parse(new TextDecoder().decode(clip.bytes)).policy : null;
    const total = Number(policy?.total_mib ?? 500) * 1024 * 1024;
    if (!Number.isFinite(total) || total < 10 * 1024 * 1024 || total > 102400 * 1024 * 1024)
      throw new Error('云端容量策略异常');
    const inventory = await bridge.inventory(),
      context = {
        pending: new Map(),
        known: new Map(Object.entries(state.asset_paths)),
        inventory,
        total,
        readAsset: options.readAsset,
        signal,
      };
    return { bridge, lease, document: clone(document), file, context };
  } catch (error) {
    await bridge.release(lease);
    throw error;
  }
}
async function markBinding(state, uuid, id, record, snapshot, api, signal) {
  state.bindings[uuid] = {
    id,
    revision: record.revision,
    data: clone(record.data),
    display: { title: snapshot.title, content: snapshot.content },
    hash: snapshot.hash,
  };
  await api(
    '/api/attr/setBlockAttrs',
    {
      id,
      attrs: {
        [ATTR.key]: `${state.space_id}:${uuid}`,
        [ATTR.revision]: record.revision,
        [ATTR.hash]: snapshot.hash,
        [ATTR.state]: 'active',
      },
    },
    signal
  );
}
async function pull(document, options, context, expected = new Map()) {
  const { state, api, signal, documentId, convert, saveState } = options;
  const converter = assetConverter(document, options.credentials, api, signal);
  const result = await importNotes(
    document,
    documentId,
    api,
    converter,
    signal,
    options.progress || (() => {}),
    {
      skip: (uuid) => !!state.detached[uuid] || options.blocked?.has(uuid),
      acceptModified: (uuid, id, currentHash) =>
        expected.get(id) === currentHash && state.bindings[uuid]?.hash === currentHash,
      beforeUpdate: async (uuid, id) => {
        const expectedHash = expected.get(id);
        if (expectedHash) {
          const latest = await api('/api/block/getBlockKramdown', { id }, signal);
          if ((await hash(canonical(latest.kramdown))) !== expectedHash)
            throw new Error('同步期间思源正文已改变，修改已保留，请重试');
        }
      },
      onNote: async (uuid, id, record) => {
        for (const [hash, path] of converter.paths) {
          const asset = document.note_assets[hash];
          context.known.set(path, asset);
          state.asset_paths[path] = asset;
        }
        if (record.deleted) {
          delete state.bindings[uuid];
          state.detached[uuid] = true;
          await saveState(state);
          return;
        }
        const current = await api('/api/block/getBlockKramdown', { id }, signal),
          attrs = await api('/api/attr/getBlockAttrs', { id }, signal);
        if ((await hash(canonical(current.kramdown))) !== attrs[ATTR.hash]) return;
        const snapshot = await readBoundNote(id, api, convert, context, signal);
        // 拉取期间的新编辑不能被当成已经同步的基线，否则下一次回传会漏掉这次修改。
        if (snapshot.hash !== snapshot.attrs[ATTR.hash]) return;
        for (const [path, asset] of context.known) state.asset_paths[path] = asset;
        await markBinding(state, uuid, id, record, snapshot, api, signal);
        delete state.pending[uuid];
        await saveState(state);
      },
    }
  );
  return result;
}
export async function syncBoth(options) {
  const { state, api, signal, documentId, convert, saveState } = options;
  const session = await setup(options),
    { bridge, lease, document, file, context } = session;
  const result = {
    uploaded: 0,
    merged: 0,
    conflicts: 0,
    detached: 0,
    unsupported: [],
    downloaded: 0,
  };
  try {
    if ((await api('/api/attr/getBlockAttrs', { id: documentId }, signal))?.type !== 'doc')
      throw new Error('目标必须是文档');
    // 云端已提交但本地改绑失败时，先恢复副本的绑定，再读取索引。
    for (const [uuid, pending] of Object.entries(state.pending)) {
      if (
        pending.target_uuid &&
        pending.target_uuid !== uuid &&
        document.records[pending.target_uuid]?.revision === pending.commit_revision
      ) {
        await markBinding(
          state,
          pending.target_uuid,
          pending.id,
          baseRecord(pending),
          { ...pending.display, hash: pending.hash },
          api,
          signal
        );
        delete state.bindings[uuid];
        delete state.pending[uuid];
        await saveState(state);
      }
    }
    await api('/api/sqlite/flushTransaction', {}, signal);
    const ids = await boundIds(documentId, api, signal),
      expected = new Map(),
      actions = [];
    const blocked = new Set();
    for (const uuid of new Set([
      ...Object.keys(document.records),
      ...Object.keys(state.bindings),
    ])) {
      if (state.detached[uuid]) continue;
      const record = document.records[uuid],
        matches = ids.get(`${document.space_id}:${uuid}`) || [],
        binding = state.bindings[uuid];
      if (matches.length > 1) {
        result.conflicts++;
        continue;
      }
      if (!matches.length) {
        if (binding) {
          state.detached[uuid] = true;
          delete state.bindings[uuid];
          result.detached++;
        }
        continue;
      }
      const id = matches[0];
      await bridge.renew(lease);
      try {
        const snapshot = await readBoundNote(id, api, convert, context, signal);
        expected.set(id, snapshot.hash);
        let base = binding;
        const pending = state.pending[uuid];
        if (pending && record?.revision === (pending.commit_revision || pending.revision)) {
          base = { ...binding, ...pending };
          state.bindings[uuid] = base;
          delete state.pending[uuid];
        }
        if (!base && record?.data && snapshot.attrs[ATTR.revision] === record.revision) {
          base = {
            id,
            revision: record.revision,
            data: record.data,
            display:
              snapshot.hash === snapshot.attrs[ATTR.hash]
                ? { title: snapshot.title, content: snapshot.content }
                : {
                    title: record.data.title || '未命名便签',
                    content: canonicalHtml(record.data.content),
                  },
            hash: snapshot.attrs[ATTR.hash],
          };
        }
        if (!base && snapshot.hash === snapshot.attrs[ATTR.hash]) continue;
        if (base && snapshot.hash === base.hash) {
          state.bindings[uuid] = base;
          continue;
        }
        const local = await sourceRecord(uuid, base, snapshot, record);
        if (base && local.revision === base.revision) {
          await markBinding(state, uuid, id, baseRecord(base), snapshot, api, signal);
          continue;
        }
        const outcome = await integrate(document, uuid, base ? baseRecord(base) : null, local);
        if (outcome.kind === 'acknowledged') {
          result.conflicts++;
          continue;
        }
        if (outcome.kind === 'merged') result.merged++;
        else if (outcome.kind === 'conflict') result.conflicts++;
        else if (outcome.kind === 'uploaded') result.uploaded++;
        const target = document.records[outcome.uuid];
        const source = outcome.kind === 'merged' ? local : target;
        state.pending[uuid] = {
          id,
          target_uuid: outcome.uuid,
          commit_revision: target.revision,
          revision: source.revision,
          data: source.data,
          display: { title: snapshot.title, content: snapshot.content },
          hash: snapshot.hash,
        };
        actions.push({ uuid, id, snapshot, target: outcome.uuid, record: source });
      } catch (error) {
        if (signal?.aborted) throw error;
        blocked.add(uuid);
        result.unsupported.push(String(error.message || '此条便签无法回传'));
      }
    }
    if (actions.length || document.schema_version !== 3) {
      // 发布前再检查所有准备上传的思源块，避免用过期的读取结果覆盖新的编辑。
      for (const action of actions) {
        const latest = await api('/api/block/getBlockKramdown', { id: action.id }, signal);
        if ((await hash(canonical(latest.kramdown))) !== action.snapshot.hash)
          throw new Error('思源内容在同步期间变化，已停止提交，请重试');
      }
      await publish(bridge, lease, document, file, context, state, saveState);
      for (const action of actions) {
        await markBinding(
          state,
          action.target,
          action.id,
          action.record,
          action.snapshot,
          api,
          signal
        );
        if (action.target !== action.uuid) delete state.bindings[action.uuid];
        delete state.pending[action.uuid];
        await saveState(state);
      }
      await api('/api/sqlite/flushTransaction', {}, signal);
    } else await saveState(state);
    for (const [path, asset] of context.known) state.asset_paths[path] = asset;
    await bridge.renew(lease);
    const imported = await pull(document, { ...options, blocked }, context, expected);
    result.downloaded = imported.added + imported.updated;
    result.conflicts += imported.conflicts;
    return { ...result, document };
  } finally {
    await bridge.release(lease);
  }
}
export async function createFromBlock(options, id) {
  if (!BLOCK_ID.test(id) || id === options.documentId)
    throw new Error('请提供未绑定的普通内容块ID');
  const session = await setup(options),
    { bridge, lease, document, file, context } = session;
  try {
    if (
      (await options.api('/api/attr/getBlockAttrs', { id: options.documentId }, options.signal))
        ?.type !== 'doc'
    )
      throw new Error('目标必须是文档');
    const attrs = await options.api('/api/attr/getBlockAttrs', { id }, options.signal);
    if (attrs[ATTR.key]) throw new Error('该区域已绑定便签，请使用双向同步');
    const content = await readNewNote(id, options.api, options.convert, context, options.signal),
      uuid = await revisionId(`create:${document.space_id}:${id}`);
    if (document.records[uuid]) throw new Error('该块已经创建过便签，请先拉取并检查现有同步区域');
    const title = (
        new DOMParser().parseFromString(content, 'text/html').body.textContent || '新便签'
      )
        .trim()
        .slice(0, 80),
      now = new Date().toISOString();
    const data = {
      title,
      content,
      color: 'default',
      is_pinned: false,
      is_completed: false,
      created_at: now,
      updated_at: now,
    };
    document.records[uuid] = {
      revision: await revisionId(`create:${uuid}:${stableJson(data)}`),
      deleted: false,
      updated_at: Date.parse(now),
      data,
    };
    await publish(bridge, lease, document, file, context, options.state, options.saveState);
    // 原内容块保留；新建受管理的便签区域，失败重试通过确定的UUID避免重复创建云端便签。
    await pull(document, options, context);
    return { uuid, title };
  } finally {
    await bridge.release(lease);
  }
}
export async function syncReadOnly(options) {
  const document = await loadNotes(options.credentials, options.api, options.signal),
    { state } = options;
  validateState(state);
  if (state.space_id && state.space_id !== document.space_id)
    throw new Error('文档绑定的同步空间已变化，请使用新文档');
  state.space_id = document.space_id;
  const ids = await boundIds(options.documentId, options.api, options.signal);
  for (const uuid of Object.keys(state.bindings))
    if (!(ids.get(`${state.space_id}:${uuid}`) || []).length) {
      state.detached[uuid] = true;
      delete state.bindings[uuid];
    }
  const context = {
    known: new Map(Object.entries(state.asset_paths)),
    pending: new Map(),
    inventory: new Map(
      Object.keys(document.note_assets || {}).map((id) => [`note-assets/${id}.bin`, 0])
    ),
    readAsset: options.readAsset,
    signal: options.signal,
  };
  const result = await pull(document, { ...options, readOnly: true }, context);
  await options.saveState(state);
  return { ...result, document };
}
export async function resolveCloudConflict(options, input) {
  const session = await setup(options),
    { bridge, lease, document, file, context } = session;
  try {
    const conflict = document.note_conflicts?.[input.id];
    if (!conflict || conflict.resolved) throw new Error('冲突已经处理，请刷新');
    const original = document.records[conflict.original_uuid],
      other = document.records[conflict.copy_uuid];
    if (stableJson(original) !== input.original || stableJson(other) !== input.other)
      throw new Error('云端版本已变化，请重新比较');
    const sourceChecks = [];
    for (const uuid of [conflict.original_uuid, conflict.copy_uuid]) {
      const binding = options.state.bindings[uuid];
      if (!binding) continue;
      const current = await options.api(
          '/api/block/getBlockKramdown',
          { id: binding.id },
          options.signal
        ),
        currentHash = await hash(canonical(current.kramdown));
      if (currentHash !== binding.hash && !(input.choice === 'merge' && input.source_uuid === uuid))
        throw new Error('思源区域存在未回传编辑，请先同步后重新比较');
      sourceChecks.push({ id: binding.id, hash: currentHash });
    }
    let data = null,
      consumed = null;
    if (input.choice === 'keep_other') data = clone(other?.data);
    else if (input.choice === 'merge') {
      const binding = options.state.bindings[input.source_uuid];
      if (!binding) throw new Error('请先拉取两个版本，并在思源便签区域整理合并内容');
      const snapshot = await readBoundNote(
        binding.id,
        options.api,
        options.convert,
        context,
        options.signal
      );
      const version = await sourceRecord(
        input.source_uuid,
        binding,
        snapshot,
        document.records[input.source_uuid]
      );
      data = {
        ...(original.data || other.data),
        title: snapshot.title,
        content: version.data.content,
      };
      consumed = { uuid: input.source_uuid, id: binding.id, record: version, snapshot };
    } else if (!['keep_original', 'keep_both'].includes(input.choice))
      throw new Error('处理方式无效');
    if (data) {
      if (input.choice === 'keep_other' && data.title === `${conflict.other_title}（同步冲突）`)
        data.title = conflict.other_title;
      data.updated_at = new Date().toISOString();
      document.records[conflict.original_uuid] = {
        revision: crypto.randomUUID(),
        deleted: false,
        updated_at: Date.parse(data.updated_at),
        data,
      };
    } else if (input.choice === 'keep_other' && other?.deleted)
      document.records[conflict.original_uuid] = {
        revision: crypto.randomUUID(),
        deleted: true,
        updated_at: Date.now(),
        data: null,
      };
    if (input.choice !== 'keep_both')
      document.records[conflict.copy_uuid] = {
        revision: crypto.randomUUID(),
        deleted: true,
        updated_at: Date.now(),
        data: null,
      };
    else if (other?.data) {
      other.data.title =
        other.data.title === `${conflict.other_title}（同步冲突）`
          ? `${conflict.other_title}（保留副本）`
          : other.data.title;
      other.data.updated_at = new Date().toISOString();
      other.updated_at = Date.now();
      other.revision = crypto.randomUUID();
    }
    conflict.resolved = true;
    conflict.base = null;
    conflict.resolution_revision = crypto.randomUUID();
    for (const check of sourceChecks) {
      const current = await options.api(
        '/api/block/getBlockKramdown',
        { id: check.id },
        options.signal
      );
      if ((await hash(canonical(current.kramdown))) !== check.hash)
        throw new Error('处理期间思源内容已变化，请重新比较');
    }
    // 手动合并已经采用的编辑需要记为已提交，避免副本归档时再触发编辑与删除冲突。
    if (consumed)
      options.state.pending[consumed.uuid] = {
        id: consumed.id,
        target_uuid: consumed.uuid,
        commit_revision: document.records[consumed.uuid].revision,
        revision: consumed.record.revision,
        data: consumed.record.data,
        display: { title: consumed.snapshot.title, content: consumed.snapshot.content },
        hash: consumed.snapshot.hash,
      };
    await publish(bridge, lease, document, file, context, options.state, options.saveState);
    if (consumed) {
      await markBinding(
        options.state,
        consumed.uuid,
        consumed.id,
        consumed.record,
        consumed.snapshot,
        options.api,
        options.signal
      );
      delete options.state.pending[consumed.uuid];
      await options.saveState(options.state);
    }
    return document;
  } finally {
    await bridge.release(lease);
  }
}
export function conflictPreview(document) {
  return Object.entries(document.note_conflicts || {})
    .filter(([, c]) => !c.resolved)
    .map(([id, c]) => ({
      id,
      original: stableJson(document.records[c.original_uuid]),
      other: stableJson(document.records[c.copy_uuid]),
      source_uuid: c.original_uuid,
      other_uuid: c.copy_uuid,
      title: document.records[c.original_uuid]?.data?.title || c.other_title,
      originalText: document.records[c.original_uuid]?.data
        ? htmlToMarkdown(document.records[c.original_uuid].data.content)
        : '此版本已删除',
      otherText: document.records[c.copy_uuid]?.data
        ? htmlToMarkdown(document.records[c.copy_uuid].data.content)
        : '此版本已删除',
    }));
}
