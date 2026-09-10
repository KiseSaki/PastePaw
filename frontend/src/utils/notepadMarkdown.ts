/**
 * Converts Tiptap HTML content to clean Markdown/plaintext for clipboard and app pasting.
 */
export function htmlToMarkdown(html: string): string {
  if (!html) return '';

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  function processNode(node: Node): string {
  function processNode(node: Node, depth: number = 0, isInsideList: boolean = false): string {
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
      const indent = '  '.repeat(depth);

      let textParts: string[] = [];
      let nestedLists = '';

      el.childNodes.forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const childEl = child as HTMLElement;
          const childTag = childEl.tagName.toLowerCase();
          if (childTag === 'label') {
            return; // Skip taskItem checkbox label
          }
          if (childTag === 'ul' || childTag === 'ol') {
            nestedLists += processNode(child, depth + 1, true);
            return;
          }
        }
        const part = processNode(child, depth, true).trim();
        if (part) {
          textParts.push(part);
        }
      });

      const textContent = textParts.join(' ');
      let res = `${indent}${mark}${textContent}\n`;
      if (nestedLists) {
        res += nestedLists;
      }
      return res;
    }

    // Standard List Item
    if (tagName === 'li') {
      const parent = el.parentElement;
      if (parent && parent.tagName.toLowerCase() === 'ol') {
        const index = Array.from(parent.children).indexOf(el) + 1;
        const inner = Array.from(el.childNodes).map(processNode).join('').trim();
        return `${index}. ${inner}\n`;
      const isOrdered = parent && parent.tagName.toLowerCase() === 'ol';
      const indent = '  '.repeat(depth);

      let mark = '- ';
      if (isOrdered) {
        const index = Array.from(parent!.children).indexOf(el) + 1;
        mark = `${index}. `;
      }
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      return `- ${inner}\n`;

      let textParts: string[] = [];
      let nestedLists = '';

      el.childNodes.forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          const childEl = child as HTMLElement;
          const childTag = childEl.tagName.toLowerCase();
          if (childTag === 'ul' || childTag === 'ol') {
            nestedLists += processNode(child, depth + 1, true);
            return;
          }
        }
        const part = processNode(child, depth, true).trim();
        if (part) {
          textParts.push(part);
        }
      });

      const textContent = textParts.join(' ');
      let res = `${indent}${mark}${textContent}\n`;
      if (nestedLists) {
        res += nestedLists;
      }
      return res;
    }

    // Lists
    // Lists (ul / ol)
    if (tagName === 'ul' || tagName === 'ol') {
      return Array.from(el.childNodes).map(processNode).join('') + '\n';
      return Array.from(el.childNodes)
        .map((child) => processNode(child, depth, true))
        .join('');
    }

    // Headings
    if (/^h[1-6]$/.test(tagName)) {
      const level = parseInt(tagName[1], 10);
      const prefix = '#'.repeat(level) + ' ';
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      const inner = Array.from(el.childNodes)
        .map((c) => processNode(c, depth))
        .join('')
        .trim();
      return `\n${prefix}${inner}\n\n`;
    }

    // Blockquote
    if (tagName === 'blockquote') {
      const inner = Array.from(el.childNodes).map(processNode).join('').trim();
      const inner = Array.from(el.childNodes)
        .map((c) => processNode(c, depth))
        .join('')
        .trim();
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
      const inner = Array.from(el.childNodes)
        .map((c) => processNode(c, depth, isInsideList))
        .join('');
      if (isInsideList) {
        return inner;
      }
      return `${inner}\n\n`;
    }

    // Inlines
    if (tagName === 'strong' || tagName === 'b') {
      return `**${Array.from(el.childNodes).map(processNode).join('')}**`;
      return `**${Array.from(el.childNodes).map((c) => processNode(c, depth, isInsideList)).join('')}**`;
    }

    if (tagName === 'em' || tagName === 'i') {
      return `*${Array.from(el.childNodes).map((c) => processNode(c, depth, isInsideList)).join('')}*`;
    }

    if (tagName === 's' || tagName === 'del' || tagName === 'strike') {
      return `~~${Array.from(el.childNodes).map(processNode).join('')}~~`;
      return `~~${Array.from(el.childNodes).map((c) => processNode(c, depth, isInsideList)).join('')}~~`;
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
    return Array.from(el.childNodes)
      .map((c) => processNode(c, depth, isInsideList))
      .join('');
  }

  const raw = Array.from(doc.body.childNodes).map(processNode).join('');
  const raw = Array.from(doc.body.childNodes)
    .map((c) => processNode(c, 0, false))
    .join('');
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
