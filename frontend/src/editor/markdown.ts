import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function markdownToHtml(text: string): string {
  const html = DOMPurify(window).sanitize(
    marked.parse(text, { async: false, gfm: true }) as string
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  // 只转换直属的复选框，子级待办不会把父级普通列表误判为待办。
  for (const list of [...doc.querySelectorAll('ul')].reverse()) {
    const items = [...list.children];
    if (
      items.some((li) =>
        li.querySelector(':scope > input[type=checkbox], :scope > p > input[type=checkbox]')
      )
    ) {
      const groups: HTMLUListElement[] = [];
      let previousTask: boolean | null = null;
      for (const li of items) {
        const checkbox = li.querySelector<HTMLInputElement>(
          ':scope > input[type=checkbox], :scope > p > input[type=checkbox]'
        );
        const task = !!checkbox;
        if (previousTask !== task) {
          const group = doc.createElement('ul');
          if (task) group.setAttribute('data-type', 'taskList');
          groups.push(group);
          previousTask = task;
        }
        if (checkbox) {
          li.setAttribute('data-type', 'taskItem');
          li.setAttribute('data-checked', String(checkbox.checked));
          if (checkbox.nextSibling?.nodeType === 3)
            checkbox.nextSibling.textContent =
              checkbox.nextSibling.textContent?.replace(/^ /, '') || '';
          checkbox.remove();
        }
        groups[groups.length - 1].appendChild(li);
      }
      list.replaceWith(...groups);
    }
  }
  return doc.body.innerHTML;
}

export function tsvToTable(text: string): string {
  const rows = text
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((line) => line.split('\t'));
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cols = Math.max(...rows.map((r) => r.length));
  return (
    '<table><tbody>' +
    rows
      .map(
        (row) =>
          '<tr>' +
          Array.from({ length: cols }, (_, i) => `<td><p>${escape(row[i] || '')}</p></td>`).join(
            ''
          ) +
          '</tr>'
      )
      .join('') +
    '</tbody></table>'
  );
}
