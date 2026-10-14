import { assetReferences } from '../../shared/noteMarkdown.js';
const encoder = new TextEncoder();
const AAD = encoder.encode('pastepaw-webdav-vault-v1');
const UUID = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
export const BLOCK_ID = /^\d{14}-[a-z0-9]{7}$/;
export const ATTR = {
  key: 'custom-pastepaw-key',
  revision: 'custom-pastepaw-revision',
  hash: 'custom-pastepaw-hash',
  state: 'custom-pastepaw-state',
};

function fail(message) {
  throw new Error(message);
}
export function base64(bytes) {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function unbase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
export async function hash(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function rootUrl(credentials) {
  let url;
  try {
    url = new URL(credentials.endpoint);
  } catch {
    fail('WebDAV 地址格式不正确');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail('请使用 HTTP 或 HTTPS 地址，并单独填写账号密码；地址不能带查询参数或片段');
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(credentials.directory) ||
    !credentials.username ||
    !credentials.password
  )
    fail('请填写账号密码及合法专用目录');
  if (
    [credentials.endpoint, credentials.username, credentials.password].some((s) => s.length > 4096)
  )
    fail('连接信息过长');
  url.pathname = url.pathname.replace(/\/$/, '') + '/' + credentials.directory + '/v1/';
  return url;
}

async function derive(password, salt, iterations, usages) {
  const material = encoder.encode(password);
  try {
    const key = await crypto.subtle.importKey('raw', material, 'PBKDF2', false, ['deriveKey']);
    return await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      key,
      { name: 'AES-GCM', length: 256 },
      false,
      usages
    );
  } finally {
    material.fill(0);
  }
}

export async function encryptVault(credentials, password) {
  rootUrl(credentials);
  if ([...password].length < 6 || encoder.encode(password).length > 1024)
    fail('独立解锁密码至少 6 个字符，且不超过 1024 字节');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, 600000, ['encrypt']);
  const plain = encoder.encode(JSON.stringify(credentials));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: AAD },
      key,
      plain
    );
    return {
      version: 1,
      iterations: 600000,
      salt: base64(salt),
      nonce: base64(nonce),
      ciphertext: base64(new Uint8Array(ciphertext)),
    };
  } finally {
    plain.fill(0);
  }
}

export async function decryptVault(vault, password) {
  if (
    !vault ||
    vault.version !== 1 ||
    !Number.isInteger(vault.iterations) ||
    vault.iterations < 600000 ||
    vault.iterations > 2000000 ||
    JSON.stringify(vault).length > 65536 ||
    encoder.encode(password).length > 1024
  )
    fail('凭据文件版本或参数不受支持');
  let plain;
  try {
    const salt = unbase64(vault.salt),
      nonce = unbase64(vault.nonce);
    if (salt.length !== 16 || nonce.length !== 12) fail('凭据文件损坏');
    const key = await derive(password, salt, vault.iterations, ['decrypt']);
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: nonce, additionalData: AAD },
        key,
        unbase64(vault.ciphertext)
      )
    );
    const credentials = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    rootUrl(credentials);
    return credentials;
  } catch {
    fail('解锁密码不正确或凭据文件被修改');
  } finally {
    plain?.fill(0);
  }
}

export async function loadNotes(credentials, api, signal) {
  const url = new URL('notes.json', rootUrl(credentials));
  const response = await api(
    '/api/network/forwardProxy',
    {
      url: url.href,
      method: 'GET',
      timeout: 15000,
      redirect: false,
      headers: [
        {
          Authorization:
            'Basic ' + base64(encoder.encode(credentials.username + ':' + credentials.password)),
        },
      ],
      responseEncoding: 'text',
    },
    signal
  );
  if (response.status === 401 || response.status === 403)
    fail('WebDAV 验证失败或便签目录无读取权限');
  if (response.status === 404) fail('远端便签文件不存在，请先在 PastePaw 完成同步');
  if (response.status !== 200) fail('WebDAV 拉取失败，请检查网络、权限和最终 HTTP 或 HTTPS 地址');
  if (typeof response.body !== 'string' || encoder.encode(response.body).length > 32 * 1024 * 1024)
    fail('便签索引过大或响应格式异常');
  let document;
  try {
    document = JSON.parse(response.body);
  } catch {
    fail('远端便签文件不完整或格式错误');
  }
  validateNotes(document);
  return document;
}

export function validateNotes(document) {
  if (
    !document ||
    ![1, 2, 3].includes(document.schema_version) ||
    !UUID.test(document.space_id) ||
    !document.records ||
    typeof document.records !== 'object' ||
    Array.isArray(document.records) ||
    Object.keys(document.records).length > 100000
  )
    fail('不支持的便签同步格式');
  const assets = document.note_assets || {};
  if (typeof assets !== 'object' || Array.isArray(assets) || Object.keys(assets).length > 100000)
    fail('附件索引格式异常');
  for (const [id, asset] of Object.entries(assets)) {
    if (
      document.schema_version < 2 ||
      !/^[a-f0-9]{64}$/.test(id) ||
      asset.hash !== id ||
      !Number.isInteger(asset.size) ||
      asset.size <= 0 ||
      asset.size > 20 * 1024 * 1024 ||
      typeof asset.name !== 'string' ||
      !asset.name ||
      asset.name.length > 512 ||
      /[/\\\0]/.test(asset.name) ||
      !['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream'].includes(
        asset.mime
      )
    )
      fail('附件标识或参数异常');
  }
  const conflicts = document.note_conflicts || {};
  if (
    typeof conflicts !== 'object' ||
    Array.isArray(conflicts) ||
    Object.keys(conflicts).length > 100000
  )
    fail('冲突索引格式异常');
  for (const [id, conflict] of Object.entries(conflicts)) {
    if (
      document.schema_version !== 3 ||
      !UUID.test(id) ||
      conflict.copy_uuid !== id ||
      !UUID.test(conflict.original_uuid) ||
      id === conflict.original_uuid ||
      !Array.isArray(conflict.revisions) ||
      conflict.revisions.length !== 2 ||
      conflict.revisions.some((rev) => !UUID.test(rev)) ||
      typeof conflict.resolved !== 'boolean' ||
      !['device', 'siyuan'].includes(conflict.source) ||
      (conflict.resolution_revision !== null && !UUID.test(conflict.resolution_revision))
    )
      fail('冲突记录结构异常');
  }
  for (const [id, record] of Object.entries(document.records)) {
    if (
      !UUID.test(id) ||
      !record ||
      !UUID.test(record.revision) ||
      typeof record.deleted !== 'boolean' ||
      record.deleted !== (record.data === null)
    )
      fail('便签记录结构异常');
    if (!record.deleted) {
      const data = record.data;
      if (
        !data ||
        typeof data.title !== 'string' ||
        typeof data.content !== 'string' ||
        typeof data.is_completed !== 'boolean' ||
        typeof data.is_pinned !== 'boolean' ||
        !Number.isFinite(Date.parse(data.created_at)) ||
        !Number.isFinite(Date.parse(data.updated_at))
      )
        fail('便签内容或时间格式异常');
      for (const id of assetReferences(data.content)) {
        if (!assets[id]) fail('便签缺少附件索引');
      }
    }
  }
}

export function escapeMarkdown(text) {
  return text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&').replace(/\r?\n/g, ' ');
}

export function canonical(text) {
  // 思源为每个子块添加 ID 和更新时间；排除这些易变字段和插件自身标记。
  let fence = '';
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const marker = line.match(/^\s*(`{3,}|~{3,})/);
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = '';
        return line;
      }
      if (fence) return line;
      return line
        .replace(/\{:([^\n}]*)\}/g, (_, attrs) => {
          const stable = attrs
            .replace(/(?:^|\s)(?:id|updated|custom-pastepaw-[\w-]+)="(?:\\.|[^"\\])*"/g, '')
            .trim();
          return stable ? '{: ' + stable + '}' : '';
        })
        .trimEnd();
    })
    .join('\n')
    .trim();
}

export function renderNote(data, markdown, key, revision) {
  const title = escapeMarkdown(data.title || '未命名便签');
  const details = `创建：${data.created_at} · 更新：${data.updated_at}${data.is_pinned ? ' · 已置顶' : ''}${data.is_completed ? ' · 已完成' : ''}`;
  return `{{{row\n\n## ${title}\n{: custom-pastepaw-part="title"}\n\n${details}\n{: custom-pastepaw-part="info"}\n\n${markdown || '（空便签）'}\n\n}}}\n{: ${ATTR.key}="${key}" ${ATTR.revision}="${revision}" ${ATTR.state}="pending"}`;
}

async function existingBlocks(api, documentId, signal) {
  // 文档 ID 已经严格验证，固定查询不接受用户提供的 SQL 片段。
  const rows = await api(
    '/api/query/sql',
    {
      stmt: `SELECT b.id,a.value AS source_key FROM blocks b JOIN attributes a ON a.block_id=b.id WHERE b.root_id='${documentId}' AND a.name='${ATTR.key}' ORDER BY b.id LIMIT 100000`,
    },
    signal
  );
  if (!Array.isArray(rows)) fail('无法读取文档内的同步标记');
  const map = new Map();
  for (const row of rows) {
    if (!BLOCK_ID.test(row.id) || typeof row.source_key !== 'string') fail('文档同步标记异常');
    const list = map.get(row.source_key) || [];
    list.push(row.id);
    map.set(row.source_key, list);
  }
  return map;
}

export async function importNotes(
  document,
  documentId,
  api,
  convertHtml,
  signal,
  progress = () => {},
  options = {}
) {
  validateNotes(document);
  if (!BLOCK_ID.test(documentId)) fail('请填写思源文档 ID，例如 20261013120000-abcdefg');
  const target = await api('/api/attr/getBlockAttrs', { id: documentId }, signal);
  if (target?.type !== 'doc') fail('目标必须是文档 ID，不能是普通内容块');
  const known = await existingBlocks(api, documentId, signal);
  const result = { added: 0, updated: 0, skipped: 0, conflicts: 0, archived: 0 };
  const entries = Object.entries(document.records);
  for (let index = 0; index < entries.length; index++) {
    if (signal?.aborted) fail('同步已取消');
    const [uuid, record] = entries[index];
    if (options.skip?.(uuid)) {
      result.skipped++;
      continue;
    }
    const key = document.space_id + ':' + uuid;
    const ids = known.get(key) || [];
    if (ids.length > 1) {
      result.conflicts++;
      progress(index + 1, entries.length);
      continue;
    }
    let id = ids[0];
    let attrs, kramdown;
    if (id) {
      attrs = await api('/api/attr/getBlockAttrs', { id }, signal);
      if (
        attrs[ATTR.revision] === record.revision &&
        attrs[ATTR.hash] &&
        attrs[ATTR.state] !== 'pending'
      ) {
        if (options.onNote) await options.onNote(uuid, id, record);
        result.skipped++;
        progress(index + 1, entries.length);
        continue;
      }
      kramdown = (await api('/api/block/getBlockKramdown', { id }, signal)).kramdown;
      if (
        typeof kramdown !== 'string' ||
        !attrs[ATTR.hash] ||
        ((await hash(canonical(kramdown))) !== attrs[ATTR.hash] &&
          !(await options.acceptModified?.(uuid, id, await hash(canonical(kramdown)))))
      ) {
        result.conflicts++;
        progress(index + 1, entries.length);
        continue;
      }
    }
    if (record.deleted) {
      if (!id) {
        result.skipped++;
        progress(index + 1, entries.length);
        continue;
      }
      const end = kramdown.lastIndexOf('\n}}}');
      if (end < 0) {
        result.conflicts++;
        progress(index + 1, entries.length);
        continue;
      }
      const archived =
        kramdown.slice(0, end) + '\n\n> 来源便签已删除，思源内容已保留。\n' + kramdown.slice(end);
      await options.beforeUpdate?.(uuid, id);
      await api('/api/block/updateBlock', { id, dataType: 'markdown', data: archived }, signal);
      result.archived++;
    } else {
      const markdown = renderNote(
        record.data,
        await convertHtml(record.data.content),
        key,
        record.revision
      );
      if (id) {
        await options.beforeUpdate?.(uuid, id);
        await api('/api/block/updateBlock', { id, dataType: 'markdown', data: markdown }, signal);
        result.updated++;
      } else {
        const operations = await api(
          '/api/block/appendBlock',
          { parentID: documentId, dataType: 'markdown', data: markdown },
          signal
        );
        id = operations
          ?.flatMap((transaction) => transaction.doOperations || [])
          .find((operation) => operation.action === 'insert')?.id;
        if (!BLOCK_ID.test(id || '')) fail('思源未返回导入块 ID，请检查目标文档后重试');
        const inserted = await api('/api/attr/getBlockAttrs', { id }, signal);
        if (inserted[ATTR.key] !== key) fail('思源未识别导入标记，请检查刚导入的内容区域');
        known.set(key, [id]);
        result.added++;
      }
    }
    const stored = await api('/api/block/getBlockKramdown', { id }, signal);
    await api(
      '/api/attr/setBlockAttrs',
      {
        id,
        attrs: {
          [ATTR.key]: key,
          [ATTR.revision]: record.revision,
          [ATTR.hash]: await hash(canonical(stored.kramdown)),
          [ATTR.state]: record.deleted ? 'deleted' : 'active',
        },
      },
      signal
    );
    progress(index + 1, entries.length);
    await options.onNote?.(uuid, id, record);
  }
  return result;
}
