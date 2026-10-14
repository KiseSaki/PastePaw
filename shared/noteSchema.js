import { Node, Extension, generateJSON, generateHTML } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import DOMPurify from 'dompurify';

const attr = (key, value) => ({
  default: value,
  parseHTML: (el) => el.getAttribute(`data-${key}`) ?? value,
  renderHTML: (attrs) => ({ [`data-${key}`]: attrs[key] }),
});
const assets = {
  asset: attr('asset', null),
  name: attr('name', ''),
  mime: attr('mime', ''),
  size: attr('size', 0),
};
const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  addAttributes() {
    return assets;
  },
  parseHTML() {
    return [{ tag: 'div[data-type="attachment"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      { ...HTMLAttributes, 'data-type': 'attachment' },
      HTMLAttributes['data-name'] || '附件',
    ];
  },
});
const Picture = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), ...assets };
  },
});
const Fold = Extension.create({
  name: 'foldAttributes',
  addGlobalAttributes() {
    return [
      {
        types: ['heading', 'listItem', 'taskItem'],
        attributes: {
          collapsed: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
            renderHTML: (attrs) => (attrs.collapsed ? { 'data-collapsed': 'true' } : {}),
          },
        },
      },
    ];
  },
});
const extensions = [
  StarterKit.configure({ link: false, heading: { levels: [1, 2, 3, 4, 5, 6] } }),
  Link.configure({ openOnClick: false, defaultProtocol: 'https', protocols: ['mailto'] }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Picture,
  Attachment,
  Highlight,
  TableKit,
  Fold,
];
export function canonicalHtml(html) {
  const safe = DOMPurify(window).sanitize(html, {
    ADD_URI_SAFE_ATTR: ['data-asset'],
    ADD_ATTR: [
      'data-type',
      'data-checked',
      'data-asset',
      'data-name',
      'data-size',
      'data-mime',
      'data-collapsed',
    ],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|pastepaw-asset):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  });
  const doc = new DOMParser().parseFromString(safe, 'text/html');
  for (const span of doc.querySelectorAll('span[style]')) {
    const marks = [];
    const style = span.style;
    if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) marks.push('strong');
    if (style.fontStyle === 'italic') marks.push('em');
    if (
      style.textDecoration.includes('underline') ||
      style.textDecorationLine.includes('underline')
    )
      marks.push('u');
    if (
      style.textDecoration.includes('line-through') ||
      style.textDecorationLine.includes('line-through')
    )
      marks.push('s');
    if (style.backgroundColor) marks.push('mark');
    if (marks.length) {
      let node = span;
      for (const tag of marks) {
        const wrap = doc.createElement(tag);
        node.replaceWith(wrap);
        wrap.appendChild(node);
        node = wrap;
      }
    }
  }
  for (const list of [...doc.querySelectorAll('ul')].reverse()) {
    const groups = [];
    let previous = null;
    for (const li of [...list.children]) {
      const checkbox = li.querySelector(
        ':scope > input[type=checkbox],:scope > p > input[type=checkbox]'
      );
      const task = li.getAttribute('data-type') === 'taskItem' || !!checkbox;
      if (task !== previous) {
        const group = doc.createElement('ul');
        if (task) group.setAttribute('data-type', 'taskList');
        groups.push(group);
        previous = task;
      }
      if (task) {
        li.setAttribute('data-type', 'taskItem');
        if (checkbox) {
          li.setAttribute('data-checked', String(checkbox.checked));
          checkbox.remove();
        }
      }
      groups.at(-1).appendChild(li);
    }
    if (groups.length) list.replaceWith(...groups);
  }
  for (const image of doc.querySelectorAll('img[data-asset]'))
    image.setAttribute('src', `pastepaw-asset:${image.getAttribute('data-asset')}`);
  const json = generateJSON(doc.body.innerHTML, extensions);
  // 列表、图片或代码块后的空段落是便签编辑器的光标入口，不把它当作内容修改。
  if (json.content?.length > 1) {
    const last = json.content.at(-1),
      prior = json.content.at(-2);
    if (last.type === 'paragraph' && !last.content?.length && prior.type !== 'paragraph')
      json.content.pop();
  }
  return generateHTML(json, extensions);
}
