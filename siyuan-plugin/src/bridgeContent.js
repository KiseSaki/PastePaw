import { canonicalHtml } from '../../shared/noteSchema.js';
import { byteHash } from './webdav.js';
import { canonical, hash } from './core.js';

const blocks = new Set([
  'NodeSuperBlock',
  'NodeParagraph',
  'NodeHeading',
  'NodeList',
  'NodeListItem',
  'NodeBlockquote',
  'NodeCodeBlock',
  'NodeTable',
  'NodeThematicBreak',
]);
const marks = new Set(['strong', 'em', 's', 'u', 'mark', 'code', 'a', 'img', 'text', 'br']);
function assertSupported(root) {
  for (const element of root.querySelectorAll('[data-type]')) {
    const types = (element.getAttribute('data-type') || '').split(' ');
    if (types.some((type) => (type.startsWith('Node') ? !blocks.has(type) : !marks.has(type))))
      throw new Error('包含便签不支持的思源内容，请保留在思源或移出该同步区域');
  }
  if (root.querySelector('iframe,video,audio,object,embed,script'))
    throw new Error('该同步区域含不支持的内容，已停止回传');
  for (const el of root.querySelectorAll('[data-type][style]'))
    if (el.style.color || el.style.fontSize || el.style.fontFamily)
      throw new Error('该区域包含便签不支持的文字样式，已保留思源内容');
}
export function assetPath(value) {
  let path;
  try {
    path = decodeURIComponent(value);
  } catch {
    throw new Error('附件路径编码异常');
  }
  if (
    !path.startsWith('assets/') ||
    /[\x00-\x1f\\]/.test(path) ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  )
    throw new Error('只支持思源工作空间内的附件');
  return path;
}
function mime(bytes) {
  if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (String.fromCharCode(...bytes.slice(0, 3)) === 'GIF') return 'image/gif';
  if (
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  return 'application/octet-stream';
}
export async function returnAssets(html, context) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const element of doc.querySelectorAll('img,a[href]')) {
    const image = element.tagName === 'IMG',
      value = element.getAttribute(image ? 'src' : 'href') || '';
    if (!image && !value.startsWith('assets/')) {
      if (!/^(https?:|mailto:)/i.test(value))
        throw new Error('包含便签不支持的链接类型，已保留思源内容');
      continue;
    }
    const path = assetPath(value);
    let asset = context.known.get(path);
    if (!asset || !context.inventory.has(`note-assets/${asset.hash}.bin`)) {
      const bytes = await context.readAsset(path, context.signal);
      if (!bytes.length || bytes.length > 20 * 1024 * 1024)
        throw new Error('单个附件超过20 MiB或为空，思源内容保留');
      const id = await byteHash(bytes),
        type = mime(bytes),
        name =
          [
            ...path
              .split('/')
              .at(-1)
              .replace(/[\x00-\x1f/\\<>:"|?*]/g, '_'),
          ]
            .slice(0, 120)
            .join('') || '附件';
      asset = { hash: id, name, mime: type, size: bytes.length };
      context.pending.set(id, { asset, bytes });
      context.known.set(path, asset);
    }
    if (image && asset.mime === 'application/octet-stream')
      throw new Error('便签仅显示PNG、JPEG、GIF和WebP图片；其他图片请作为附件保存');
    const replacement = image ? doc.createElement('img') : doc.createElement('div');
    if (image) {
      replacement.setAttribute('src', `pastepaw-asset:${asset.hash}`);
      replacement.setAttribute('alt', element.getAttribute('alt') || asset.name);
    } else replacement.setAttribute('data-type', 'attachment');
    for (const [key, value] of Object.entries({
      asset: asset.hash,
      name: asset.name,
      mime: asset.mime,
      size: asset.size,
    }))
      replacement.setAttribute(`data-${key}`, String(value));
    if (!image) replacement.textContent = element.textContent || asset.name;
    element.replaceWith(replacement);
  }
  for (const paragraph of doc.querySelectorAll('p'))
    if (paragraph.querySelector(':scope > img,:scope > div[data-type="attachment"]')) {
      const children = [...paragraph.childNodes];
      if (
        children.some((n) =>
          n.nodeType === 3
            ? !!n.textContent.trim()
            : n.nodeType !== 1 ||
              !(n.tagName === 'IMG' || n.getAttribute('data-type') === 'attachment')
        )
      )
        throw new Error('请将图片和附件单独成段后回传');
      paragraph.replaceWith(...children.filter((n) => n.nodeType === 1));
    }
  return doc.body.innerHTML;
}
export async function readBoundNote(id, api, convert, context, signal) {
  const before = await api('/api/block/getBlockKramdown', { id }, signal);
  const [dom, attrs] = await Promise.all([
    api('/api/block/getBlockDOM', { id }, signal),
    api('/api/attr/getBlockAttrs', { id }, signal),
  ]);
  const kramdown = await api('/api/block/getBlockKramdown', { id }, signal);
  if (
    typeof before?.kramdown !== 'string' ||
    (await hash(canonical(before.kramdown))) !== (await hash(canonical(kramdown.kramdown)))
  )
    throw new Error('读取时思源内容正在变化，请稍后同步');
  if (typeof dom?.dom !== 'string' || typeof kramdown?.kramdown !== 'string')
    throw new Error('无法读取思源同步区域');
  const doc = new DOMParser().parseFromString(dom.dom, 'text/html');
  const root = doc.querySelector(`[data-node-id="${id}"]`);
  if (!root || root.getAttribute('data-type') !== 'NodeSuperBlock')
    throw new Error('同步区域结构已改变，请解除绑定或恢复便签区域');
  assertSupported(root);
  const children = [...root.children].filter((el) => el.hasAttribute('data-node-id'));
  const title =
    children.find((el) => el.getAttribute('custom-pastepaw-part') === 'title') || children[0];
  const info =
    children.find((el) => el.getAttribute('custom-pastepaw-part') === 'info') || children[1];
  if (
    title?.getAttribute('data-type') !== 'NodeHeading' ||
    info?.getAttribute('data-type') !== 'NodeParagraph' ||
    !(info.textContent || '').startsWith('创建：')
  )
    throw new Error('便签标题或信息区域已改变，请恢复后同步');
  const text = title.querySelector('[contenteditable]')?.textContent || title.textContent || '';
  const body = children
    .filter((el) => el !== title && el !== info)
    .map((el) => el.outerHTML)
    .join('');
  const html = await returnAssets(convert(body), context);
  return {
    title: text.trim(),
    content: canonicalHtml(html),
    hash: await hash(canonical(kramdown.kramdown)),
    attrs,
  };
}
export async function readNewNote(id, api, convert, context, signal) {
  const result = await api('/api/block/getBlockDOM', { id }, signal);
  if (typeof result?.dom !== 'string') throw new Error('无法读取选中的块');
  const doc = new DOMParser().parseFromString(result.dom, 'text/html');
  assertSupported(doc.body);
  const html = await returnAssets(convert(doc.body.innerHTML), context);
  return canonicalHtml(html);
}
