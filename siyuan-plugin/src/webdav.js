import { base64, rootUrl, validateNotes } from './core.js';
const encoder = new TextEncoder(),
  decoder = new TextDecoder('utf-8', { fatal: true });
const MAX = 32 * 1024 * 1024;
function statusError(status) {
  if ([401, 403].includes(status)) return new Error('WebDAV 验证失败或账号没有写权限');
  if (status === 412) return new Error('云端内容已变化或另一端正在同步，请重新同步');
  if (status === 507) return new Error('WebDAV 服务器容量已满，本地和思源内容已保留');
  return new Error(`WebDAV 请求失败（HTTP ${status}）`);
}
export class Webdav {
  constructor(credentials, api, signal) {
    this.credentials = credentials;
    this.api = api;
    this.signal = signal;
    this.root = rootUrl(credentials);
    this.serverDate = null;
    this.received = 0;
  }
  now() {
    if (this.serverDate === null) throw new Error('服务器未返回有效时间，无法安全同步');
    return this.serverDate + performance.now() - this.received;
  }
  async request(path, method = 'GET', bytes, headers = {}, encoding = 'text') {
    if (this.signal?.aborted) throw new Error('同步已取消');
    if (
      !/^(?:notes(?:-backup)?\.json|clipboard\.json|lease\.json|probe-[a-f0-9-]+\.json|note-assets\/[a-f0-9]{64}\.bin|(?:assets\/|note-assets\/)?$)/.test(
        path
      )
    )
      throw new Error('同步文件路径无效');
    const response = await this.api(
      '/api/network/forwardProxy',
      {
        url: new URL(path, this.root).href,
        method,
        redirect: false,
        timeout: 20000,
        headers: [
          {
            Authorization:
              'Basic ' +
              base64(encoder.encode(this.credentials.username + ':' + this.credentials.password)),
            ...headers,
          },
        ],
        contentType:
          method === 'PROPFIND' ? 'application/xml; charset=utf-8' : 'application/octet-stream',
        ...(bytes === undefined ? {} : { payload: base64(bytes), payloadEncoding: 'base64' }),
        responseEncoding: encoding,
      },
      this.signal
    );
    const normalized = {};
    for (const [key, values] of Object.entries(response.headers || {}))
      normalized[key.toLowerCase()] = Array.isArray(values) ? values[0] : values;
    const date = Date.parse(normalized.date);
    if (Number.isFinite(date)) {
      this.serverDate = date;
      this.received = performance.now();
    }
    return { ...response, headers: normalized };
  }
  async get(path, limit = MAX, binary = false) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.request(path, 'GET', undefined, {}, binary ? 'base64' : 'text');
      if (response.status === 404) return null;
      if (response.status !== 200) throw statusError(response.status);
      if (
        typeof response.body !== 'string' ||
        response.body.length > (binary ? Math.ceil(limit / 3) * 4 + 4 : limit * 3)
      )
        throw new Error('同步响应过大或格式异常');
      const bytes = binary
        ? Uint8Array.from(atob(response.body), (c) => c.charCodeAt(0))
        : encoder.encode(response.body);
      if (bytes.length > limit) throw new Error('同步文件超过大小上限');
      const etag = response.headers.etag;
      if (typeof etag === 'string' && /^"[^"\r\n]+"$/.test(etag)) return { bytes, etag };
      // Apache 对刚写入的文件可能暂时返回弱 ETag，等待后必须重新读取正文与标签。
      if (attempt < 2)
        await new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error('同步已取消'));
          };
          const timer = setTimeout(() => {
            this.signal?.removeEventListener('abort', abort);
            resolve();
          }, 1100);
          this.signal?.addEventListener('abort', abort, { once: true });
        });
    }
    throw new Error('WebDAV 未返回强 ETag，不能开启安全的双向同步');
  }
  async put(path, bytes, etag = null) {
    const response = await this.request(
      path,
      'PUT',
      bytes,
      etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }
    );
    if (response.status < 200 || response.status >= 300) throw statusError(response.status);
    const saved = await this.get(
      path,
      Math.max(bytes.length, 4096),
      path.startsWith('note-assets/')
    );
    if (
      !saved ||
      saved.bytes.length !== bytes.length ||
      (await byteHash(saved.bytes)) !== (await byteHash(bytes))
    )
      throw new Error('服务器写入后的内容校验失败');
    return saved.etag;
  }
  async initialize() {
    for (const path of ['note-assets/']) {
      const response = await this.request(path, 'MKCOL');
      if (![201, 200, 204, 405].includes(response.status)) throw statusError(response.status);
    }
  }
  async probe() {
    const path = `probe-${crypto.randomUUID()}.json`;
    let etag;
    try {
      etag = await this.put(path, encoder.encode('{"probe":1}'));
      const duplicate = await this.request(path, 'PUT', encoder.encode('{"probe":2}'), {
        'If-None-Match': '*',
      });
      if (duplicate.status !== 412) throw new Error('服务器忽略了条件写入，不能安全同步');
      const stale = await this.request(path, 'PUT', encoder.encode('{"probe":3}'), {
        'If-Match': '"pastepaw-invalid-etag"',
      });
      if (stale.status !== 412) throw new Error('服务器忽略了版本校验，不能安全同步');
      const file = await this.get(path, 4096);
      if (!file || decoder.decode(file.bytes) !== '{"probe":1}')
        throw new Error('服务器条件写入验证失败');
      this.now();
    } finally {
      if (etag) await this.request(path, 'DELETE', undefined, { 'If-Match': etag }).catch(() => {});
    }
  }
  async acquire() {
    const previous = await this.get('lease.json', 4096);
    if (previous) {
      let lease;
      try {
        lease = JSON.parse(decoder.decode(previous.bytes));
      } catch {
        throw new Error('云端同步锁损坏');
      }
      if (!Number.isFinite(lease.expires_at)) throw new Error('云端同步锁格式异常');
      if (lease.expires_at > this.now()) throw new Error('另一台电脑或思源正在同步，请稍后重试');
    }
    const lease = { owner: crypto.randomUUID(), etag: '' };
    lease.etag = await this.put(
      'lease.json',
      encoder.encode(
        JSON.stringify({ owner: lease.owner, expires_at: Math.floor(this.now() + 120000) })
      ),
      previous?.etag
    );
    return lease;
  }
  async renew(lease) {
    lease.etag = await this.put(
      'lease.json',
      encoder.encode(
        JSON.stringify({ owner: lease.owner, expires_at: Math.floor(this.now() + 120000) })
      ),
      lease.etag
    );
  }
  async release(lease) {
    if (this.signal?.aborted) return;
    await this.put(
      'lease.json',
      encoder.encode(JSON.stringify({ owner: lease.owner, expires_at: 0 })),
      lease.etag
    ).catch(() => {});
  }
  async inventory() {
    const result = new Map();
    const payload = encoder.encode(
      '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'
    );
    for (const path of ['', 'assets/', 'note-assets/']) {
      const response = await this.request(path, 'PROPFIND', payload, { Depth: '1' });
      if (
        response.status !== 207 ||
        typeof response.body !== 'string' ||
        encoder.encode(response.body).length > 4 * 1024 * 1024
      )
        throw new Error('WebDAV 目录容量查询失败');
      const xml = new DOMParser().parseFromString(response.body, 'application/xml');
      if (xml.querySelector('parsererror')) throw new Error('WebDAV 目录响应格式异常');
      for (const item of xml.getElementsByTagNameNS('DAV:', 'response')) {
        if (item.getElementsByTagNameNS('DAV:', 'collection').length) continue;
        const href = item.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent;
        const url = new URL(href, this.root);
        if (url.origin !== this.root.origin || !url.pathname.startsWith(this.root.pathname))
          throw new Error('服务器返回了同步目录外的路径');
        const relative = url.pathname.slice(this.root.pathname.length);
        if (!relative || relative.endsWith('/')) continue;
        const size = item.getElementsByTagNameNS('DAV:', 'getcontentlength')[0]?.textContent;
        if (!/^\d+$/.test(size || '') || !Number.isSafeInteger(Number(size)))
          throw new Error('服务器未返回有效文件大小，不能核算容量');
        result.set(relative, Number(size));
      }
    }
    return result;
  }
  async notes() {
    const file = await this.get('notes.json');
    if (!file) throw new Error('请先在便签完成一次 WebDAV 同步');
    let document;
    try {
      document = JSON.parse(decoder.decode(file.bytes));
    } catch {
      throw new Error('云端便签索引损坏');
    }
    validateNotes(document);
    return { file, document };
  }
}
export async function byteHash(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export function encodeJson(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MAX) throw new Error('同步索引超过 32 MiB，本地修改保留');
  return bytes;
}
