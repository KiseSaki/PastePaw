import { wrappingInputRule } from '@tiptap/core';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { markdownToHtml, tsvToTable } from './markdown';
import { MixedListKeyboard } from './lists';
import { NoteStructure } from './structure';
import { Attachment, insertFiles, NoteCodeBlock, NoteImage } from './assets';

const CustomTaskItem = TaskItem.extend({
  addInputRules() {
    return [
      ...(this.parent?.() || []),
      wrappingInputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        type: this.type,
        getAttributes: (m) => ({ checked: m[1].toLowerCase() === 'x' }),
      }),
    ];
  },
});
export function noteExtensions() {
  return [
    StarterKit.configure({
      link: false,
      codeBlock: false,
      heading: { levels: [1, 2, 3, 4, 5, 6] },
    }),
    TaskList,
    CustomTaskItem.configure({ nested: true }),
    MixedListKeyboard,
    NoteStructure,
    Link.configure({
      openOnClick: false,
      autolink: true,
      defaultProtocol: 'https',
      protocols: ['mailto'],
    }),
    Highlight,
    TableKit.configure({ table: { resizable: true } }),
    NoteCodeBlock,
    NoteImage,
    Attachment,
  ];
}

export function handleNotePaste(
  editor: import('@tiptap/core').Editor,
  event: ClipboardEvent
): boolean {
  const data = event.clipboardData;
  if (!data) return false;
  const files = Array.from(data.files);
  if (files.length) {
    void insertFiles(editor, files);
    return true;
  }
  if (editor.isActive('codeBlock')) return false;
  const text = data.getData('text/plain');
  // Excel 带 HTML 表格时交给原有 HTML 解析；纯 TSV 转成普通可编辑表格。
  if (data.getData('text/html')) return false;
  if (text.includes('\t')) {
    editor.commands.insertContent(tsvToTable(text));
    return true;
  }
  if (
    /(^|\n)(?:#{1,6} |\s*(?:[-*+] |\d+[.)] )|> |```|~~~|\|.*\|)|\*\*[^\n]+\*\*|\[[^\]]+\]\(https?:/m.test(
      text
    )
  ) {
    editor.commands.insertContent(markdownToHtml(text));
    return true;
  }
  return false;
}
