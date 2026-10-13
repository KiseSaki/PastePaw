/**
 * 将便签 HTML 转换为适合复制和导入的 Markdown。
 */
export { htmlToMarkdown } from '../../../shared/noteMarkdown.js';

export function ensureHtmlContent(text: string): string {
  if (!text) return '<p></p>';
  // 已有 HTML 直接交给编辑器加载。
  if (/<[a-z][\s\S]*>/i.test(text)) {
    return text;
  }
  // 旧版纯文本按段落加载，不擅自重新解释历史内容。
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
 * 提取侧边栏预览用的纯文本。
 */
export function extractPlainTextPreview(content: string, maxLen = 120): string {
  if (!content) return '';
  // 移除 HTML 标签。
  let text = content.replace(/<[^>]*>/g, ' ');
  // 移除 Markdown 标记。
  text = text.replace(/#+\s+/g, '');
  text = text.replace(/[-*+]\s+\[[ xX]\]\s+/g, '☐ ');
  text = text.replace(/[-*+]\s+/g, '• ');
  text = text.replace(/\*\*(.*?)\*\*/g, '$1');
  text = text.replace(/~~(.*?)~~/g, '$1');
  text = text.replace(/`(.*?)`/g, '$1');
  // 合并预览中的空白。
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxLen) {
    return text.slice(0, maxLen) + '...';
  }
  return text;
}
