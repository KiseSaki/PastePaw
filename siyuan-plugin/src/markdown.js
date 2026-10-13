// 转换思源需要的 Markdown，保留文本字面含义，避免把便签内容当成同步标记或脚本。
export function htmlToMarkdown(html) {
  if (!html) return '';
  const template = document.createElement('template');
  template.innerHTML = html;
  const escape = (text) => text.replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&');
  const children = (node, depth = 0) =>
    [...node.childNodes].map((child) => walk(child, depth)).join('');
  const backticks = (text, minimum) =>
    '`'.repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));

  function item(node, depth, index, ordered) {
    const task = node.getAttribute('data-type') === 'taskItem';
    const prefix = task
      ? node.getAttribute('data-checked') === 'true'
        ? '- [x] '
        : '- [ ] '
      : ordered
        ? `${index}. `
        : '- ';
    const indent = ' '.repeat(depth);
    let text = '',
      nested = '';
    for (const child of node.childNodes) {
      const tag = child.nodeType === 1 ? child.tagName.toLowerCase() : '';
      if (tag === 'label' || tag === 'input') continue;
      if (tag === 'ul' || tag === 'ol') nested += walk(child, depth + (task ? 2 : prefix.length));
      else text += tag === 'p' ? children(child, depth) + '\n' : walk(child, depth);
    }
    const lines = text.trim().split('\n');
    return (
      indent +
      prefix +
      lines[0] +
      '\n' +
      lines
        .slice(1)
        .map((line) => indent + ' '.repeat(prefix.length) + line + '\n')
        .join('') +
      nested
    );
  }

  function walk(node, depth = 0) {
    if (node.nodeType === 3) return escape(node.textContent || '');
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    if (['script', 'style', 'iframe', 'object', 'embed', 'input', 'label'].includes(tag)) return '';
    if (tag === 'pre') {
      const text = node.textContent || '';
      const fence = backticks(text, 3);
      return `\n${fence}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    }
    if (tag === 'code') {
      const text = node.textContent || '';
      const fence = backticks(text, 1);
      const pad = /^[` ]|[` ]$/.test(text) ? ' ' : '';
      return fence + pad + text + pad + fence;
    }
    if (tag === 'ul' || tag === 'ol') {
      const start = Number(node.getAttribute('start')) || 1;
      return (
        '\n' +
        [...node.children]
          .filter((child) => child.tagName.toLowerCase() === 'li')
          .map((child, index) => item(child, depth, start + index, tag === 'ol'))
          .join('') +
        '\n'
      );
    }
    if (/^h[1-6]$/.test(tag))
      return '\n' + '#'.repeat(Number(tag[1])) + ' ' + children(node, depth).trim() + '\n\n';
    if (tag === 'blockquote')
      return (
        '\n' +
        children(node, depth)
          .trim()
          .split('\n')
          .map((line) => '> ' + line)
          .join('\n') +
        '\n\n'
      );
    if (tag === 'p' || tag === 'div') return children(node, depth) + '\n\n';
    if (tag === 'strong' || tag === 'b') return '**' + children(node, depth) + '**';
    if (tag === 'em' || tag === 'i') return '*' + children(node, depth) + '*';
    if (tag === 's' || tag === 'del' || tag === 'strike')
      return '~~' + children(node, depth) + '~~';
    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      if (!/^(https?:|mailto:)/i.test(href)) return children(node, depth);
      return (
        '[' +
        children(node, depth) +
        '](' +
        href.replace(/[\s()<>\\]/g, (c) => encodeURIComponent(c)) +
        ')'
      );
    }
    if (tag === 'hr') return '\n---\n\n';
    if (tag === 'br') return '\n';
    if (tag === 'img') return escape(node.getAttribute('alt') || '图片');
    return children(node, depth);
  }
  return children(template.content).trim();
}
