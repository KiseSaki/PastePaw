/**
 * Converts Tiptap HTML content to clean Markdown/plaintext for clipboard and app pasting.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  function processNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node as HTMLElement;
    const tagName = el.tagName.toLowerCase();

    // Task Item
    if (tagName === 'li' && el.getAttribute('data-type') === 'taskItem') {
      const checked = el.getAttribute('data-checked') === 'true';
      const mark = checked ? '- [x] ' : '- [ ] ';
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      return `${mark}${inner}\n`;
    }

    // Standard List Item
    if (tagName === 'li') {
      const parent = el.parentElement;
      if (parent && parent.tagName.toLowerCase() === 'ol') {
        const index = Array.from(parent.children).indexOf(el) + 1;
        const inner = Array.from(el.childNodes).map(processNode).join('').trim();
        return `${index}. ${inner}\n`;
      }
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      return `- ${inner}\n`;
    }

    // Lists
    if (tagName === 'ul' || tagName === 'ol') {
      return Array.from(el.childNodes).map(processNode).join('') + '\n';
    }

    // Headings
    if (/^h[1-6]$/.test(tagName)) {
      const level = parseInt(tagName[1], 10);
      const prefix = '#'.repeat(level) + ' ';
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      return `\n${prefix}${inner}\n\n`;
    }

    // Blockquote
    if (tagName === 'blockquote') {
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      return `\n> ${inner}\n\n`;
    }

    // Code block
    if (tagName === 'pre') {
      const code = el.textContent || '';
      return `\n\`\`\`\n${code.trim()}\n\`\`\`\n\n`;
    }

    // Horizontal Rule
    if (tagName === 'hr') {
      return '\n---\n\n';
    }

    // Paragraph
    if (tagName === 'p') {
      const inner = Array.from(el.childNodes).map(processNode).join('');
      return `${inner}\n\n`;
    }

    // Inlines
    if (tagName === 'strong' || tagName === 'b') {
      return `**${Array.from(el.childNodes).map(processNode).join('')}**`;
    }

    if (tagName === 's' || tagName === 'del' || tagName === 'strike') {
      return `~~${Array.from(el.childNodes).map(processNode).join('')}~~`;
    }

    if (tagName === 'code') {
      return `\`${el.textContent || ''}\``;
    }

    if (tagName === 'a') {
      const href = el.getAttribute('href') || '';
      const text = el.textContent || '';
      if (!text || text === href) return href;
      return `[${text}](${href})`;
    }

    if (tagName === 'br') {
      return '\n';
    }

    return Array.from(el.childNodes).map(processNode).join('');
  }

  const raw = Array.from(doc.body.childNodes).map(processNode).join('');
  // Normalize consecutive newlines
  return raw.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Converts plain text / markdown into basic HTML paragraphs if loaded from legacy plain text.
 */
export function ensureHtmlContent(text: string): string {
  if (!text) return '<p></p>';
  // If already contains html tags
  if (/<[a-z][\s\S]*>/i.test(text)) {
    return text;
  }
  // Convert newlines to paragraphs
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) =>
      line.trim()
        ? `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`
        : '<p></p>'
    )
    .join('');
  return paragraphs || '<p></p>';
}

/**
 * Extracts plain text without HTML / Markdown symbols for sidebar preview.
 */
export function extractPlainTextPreview(content: string, maxLen = 120): string {
  if (!content) return '';
  // Strip HTML tags if HTML
  let text = content.replace(/<[^>]*>/g, ' ');
  // Strip markdown markers
  text = text.replace(/#+\s+/g, '');
  text = text.replace(/[-*+]\s+\[[ xX]\]\s+/g, '☐ ');
  text = text.replace(/[-*+]\s+/g, '• ');
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/`(.*?)`/g, '$1');
  // Collapse whitespace
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + '...';
  }
  return text;
}
