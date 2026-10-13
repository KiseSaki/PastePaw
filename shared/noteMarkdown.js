// 两端共用转换器，避免便签复制和思源导入产生不同的列表结构。
export function assetReferences(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const refs = new Set();
  for (const el of doc.querySelectorAll('[data-asset]')) {
    const id = el.getAttribute('data-asset');
    if (!/^[a-f0-9]{64}$/.test(id || '')) throw new Error('附件标识无效');
    refs.add(id);
  }
  return [...refs];
}
export function htmlToMarkdown(html, resolveAsset = (hash) => `pastepaw-asset:${hash}`) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const escape = (s) => s.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&');
  const url = (s) =>
    /^assets\//.test(s || '')
      ? s.split('/').map(encodeURIComponent).join('/')
      : /^(https?:|mailto:|pastepaw-asset:)/i.test(s || '')
        ? s.replace(/[\s()<>]/g, (c) => encodeURIComponent(c))
        : '';
  const children = (node) => [...node.childNodes].map(walk).join('');
  function list(node) {
    const start = Number(node.getAttribute('start')) || 1;
    return [...node.children]
      .filter((n) => n.tagName === 'LI')
      .map((item, i) => {
        const task =
          item.getAttribute('data-type') === 'taskItem' ||
          item.querySelector(':scope > input[type=checkbox]');
        const marker = task
          ? `- [${item.getAttribute('data-checked') === 'true' || item.querySelector(':scope > input:checked') ? 'x' : ' '}] `
          : node.tagName === 'OL'
            ? `${start + i}. `
            : '- ';
        const indent = task ? 2 : marker.length;
        // Tiptap 待办项的正文和子列表放在同一个 div 中，先展开该包装层。
        const body = [...item.childNodes].flatMap((n) =>
          n.nodeType === 1 && n.tagName === 'DIV' ? [...n.childNodes] : [n]
        );
        let text = '';
        for (const child of body) {
          if (child.nodeType === 1 && ['UL', 'OL'].includes(child.tagName)) {
            text =
              text.trimEnd() +
              '\n' +
              list(child)
                .split('\n')
                .map((line) => ' '.repeat(indent) + line)
                .join('\n') +
              '\n';
          } else if (child.nodeType === 1 && child.tagName === 'P') {
            const paragraph = children(child);
            text += (text && !text.endsWith('\n') ? '\n\n' : '') + paragraph;
          } else {
            if (
              child.nodeType === 1 &&
              ['PRE', 'BLOCKQUOTE', 'TABLE', 'DIV', 'IMG'].includes(child.tagName) &&
              text &&
              !text.endsWith('\n\n')
            )
              text += '\n\n';
            text += walk(child);
          }
        }
        const lines = text.trimEnd().split('\n');
        return (
          marker +
          (lines.shift() || '') +
          lines
            .map(
              (line) =>
                '\n' + (line.startsWith(' '.repeat(indent)) ? line : ' '.repeat(indent) + line)
            )
            .join('')
        );
      })
      .join('\n');
  }
  function walk(node) {
    if (node.nodeType === 3) return escape(node.textContent || '');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName;
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'LABEL'].includes(tag)) return '';
    const asset = node.getAttribute('data-asset');
    if (asset && /^[a-f0-9]{64}$/.test(asset)) {
      const name = escape(node.getAttribute('data-name') || node.getAttribute('alt') || '附件');
      return `${tag === 'IMG' ? '!' : ''}[${name}](${url(resolveAsset(asset))})${tag === 'IMG' ? '' : '\n\n'}`;
    }
    if (tag === 'PRE') {
      const code = node.querySelector('code') || node;
      const value = code.textContent || '';
      const longest = Math.max(2, ...[...value.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = '`'.repeat(longest + 1);
      const language = (code.className.match(/language-([\w+-]+)/)?.[1] || '').replace(
        /[^\w+-]/g,
        ''
      );
      return `${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    if (tag === 'UL' || tag === 'OL') return list(node) + '\n\n';
    if (tag === 'TABLE') {
      const rows = [...node.querySelectorAll('tr')].map((row) =>
        [...row.children].map((cell) =>
          children(cell)
            .trim()
            .replace(/\n/g, '<br>')
            .replace(/(?<!\\)\|/g, '\\|')
        )
      );
      if (!rows.length) return '';
      const cols = Math.max(...rows.map((r) => r.length));
      const row = (r) =>
        '| ' + Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ') + ' |';
      return (
        [row(rows[0]), row(Array(cols).fill('---')), ...rows.slice(1).map(row)].join('\n') + '\n\n'
      );
    }
    const inner = children(node);
    if (/^H[1-6]$/.test(tag)) return '#'.repeat(Number(tag[1])) + ' ' + inner.trim() + '\n\n';
    if (tag === 'BLOCKQUOTE')
      return (
        inner
          .trimEnd()
          .split('\n')
          .map((s) => '> ' + s)
          .join('\n') + '\n\n'
      );
    if (tag === 'P' || tag === 'DIV') return inner + '\n\n';
    if (tag === 'STRONG' || tag === 'B') return `**${inner}**`;
    if (tag === 'EM' || tag === 'I') return `*${inner}*`;
    if (['S', 'DEL', 'STRIKE'].includes(tag)) return `~~${inner}~~`;
    if (tag === 'U') return `<u>${inner}</u>`;
    if (tag === 'MARK') return `<mark>${inner}</mark>`;
    if (tag === 'CODE') {
      const value = node.textContent || '';
      const fence = '`'.repeat(
        Math.max(0, ...[...value.matchAll(/`+/g)].map((m) => m[0].length)) + 1
      );
      const padding = /(^`|`$|^ .* $)/.test(value) ? ' ' : '';
      return fence + padding + value + padding + fence;
    }
    if (tag === 'A')
      return url(node.getAttribute('href'))
        ? `[${inner}](${url(node.getAttribute('href'))})`
        : inner;
    if (tag === 'IMG')
      return url(node.getAttribute('src'))
        ? `![${escape(node.getAttribute('alt') || '')}](${url(node.getAttribute('src'))})`
        : escape(node.getAttribute('alt') || '');
    if (tag === 'BR') return '  \n';
    if (tag === 'HR') return '---\n\n';
    return inner;
  }
  // 不压缩全局空行，否则会改变代码块正文。
  return children(doc.body).trimEnd().replace(/^\n+/, '');
}
