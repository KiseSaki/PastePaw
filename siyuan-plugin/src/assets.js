import { base64, rootUrl } from './core.js';
import { htmlToMarkdown } from './markdown.js';
import { assetReferences } from '../../shared/noteMarkdown.js';

export function assetConverter(document, credentials, api, signal) {
  const uploaded = new Map();
  return async (html) => {
    for (const id of assetReferences(html)) {
      if (uploaded.has(id)) continue;
      const asset = document.note_assets?.[id];
      if (!asset) throw new Error('便签附件索引不完整');
      const response = await api(
        '/api/network/forwardProxy',
        {
          url: new URL(`note-assets/${id}.bin`, rootUrl(credentials)).href,
          method: 'GET',
          timeout: 20000,
          redirect: false,
          headers: [
            {
              Authorization:
                'Basic ' +
                base64(new TextEncoder().encode(credentials.username + ':' + credentials.password)),
            },
          ],
          responseEncoding: 'base64',
        },
        signal
      );
      if (
        response.status !== 200 ||
        typeof response.body !== 'string' ||
        response.body.length > Math.ceil(asset.size / 3) * 4 + 4
      )
        throw new Error('拉取附件失败，请检查 WebDAV 文件和权限');
      let bytes;
      try {
        bytes = Uint8Array.from(atob(response.body), (c) => c.charCodeAt(0));
      } catch {
        throw new Error('远端附件编码异常');
      }
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      if (bytes.length !== asset.size || hash !== id)
        throw new Error('远端附件校验失败，便签正文未导入');
      const form = new FormData();
      const name = id.slice(0, 12) + '-' + asset.name.replace(/[\x00-\x1f/\\<>:"|?*]/g, '_');
      form.append('assetsDirPath', '/assets/');
      form.append('file[]', new Blob([bytes], { type: asset.mime }), name);
      const result = await api('/api/asset/upload', form, signal);
      const path =
        result?.succFiles?.find((file) => file.index === 0)?.path || result?.succMap?.[name];
      if (
        !path ||
        !path.startsWith('assets/') ||
        path.length > 2048 ||
        /[\x00-\x1f\\]/.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        result?.errFiles?.length
      )
        throw new Error('思源附件保存失败，正文未导入');
      uploaded.set(id, path);
    }
    return htmlToMarkdown(html, (id) => uploaded.get(id));
  };
}
