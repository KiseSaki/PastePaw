import { Editor, Extension } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { nearestItem } from './lists';
import { Node as PMNode } from '@tiptap/pm/model';

export type Match = { from: number; to: number };
export function findMatches(
  editor: Editor,
  query: string,
  caseSensitive = false,
  doc: PMNode = editor.state.doc
): Match[] {
  if (!query) return [];
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textBetween(0, node.content.size, '', '\ufffc');
    const pattern = new RegExp(
      query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      caseSensitive ? 'g' : 'gi'
    );
    for (const match of text.matchAll(pattern)) {
      matches.push({ from: pos + 1 + match.index, to: pos + 1 + match.index + match[0].length });
    }
    return false;
  });
  return matches;
}
export const searchKey = new PluginKey<{ query: string; caseSensitive: boolean }>('noteSearch');

export function activeBlock(editor: Editor) {
  const { $from } = editor.state.selection;
  if (!$from.depth)
    return {
      node: editor.state.doc.nodeAt($from.pos) || editor.state.doc.firstChild!,
      pos: $from.pos,
      depth: 1,
      index: $from.index(0),
      parent: editor.state.doc,
    };
  const item = nearestItem($from);
  const depth = item > 0 ? item : 1;
  return {
    node: $from.node(depth),
    pos: $from.before(depth),
    depth,
    index: $from.index(depth - 1),
    parent: $from.node(depth - 1),
  };
}
export function blockAction(editor: Editor, action: 'up' | 'down' | 'duplicate' | 'delete') {
  const { node, pos, index, parent } = activeBlock(editor);
  const tr = editor.state.tr;
  let target = pos;
  if (action === 'duplicate') {
    tr.insert(pos + node.nodeSize, node);
    target += node.nodeSize;
  } else if (action === 'delete') tr.delete(pos, pos + node.nodeSize);
  else {
    const other = parent.maybeChild(index + (action === 'up' ? -1 : 1));
    if (!other) return false;
    target = action === 'up' ? pos - other.nodeSize : pos + other.nodeSize;
    tr.delete(pos, pos + node.nodeSize).insert(target, node);
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(target + 1, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const NoteStructure = Extension.create({
  name: 'noteStructure',
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
  addKeyboardShortcuts() {
    return {
      'Alt-ArrowUp': () => blockAction(this.editor, 'up'),
      'Alt-ArrowDown': () => blockAction(this.editor, 'down'),
      'Mod-Alt-d': () => blockAction(this.editor, 'duplicate'),
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: searchKey,
        state: {
          init: () => ({ query: '', caseSensitive: false }),
          apply: (tr, previous) => tr.getMeta(searchKey) || previous,
        },
        props: {
          decorations(state) {
            const search = searchKey.getState(state)!;
            const decorations: Decoration[] = findMatches(
              editor,
              search.query,
              search.caseSensitive,
              state.doc
            ).map((m) => Decoration.inline(m.from, m.to, { class: 'note-search-match' }));
            // 标题折叠只影响同级后续内容，不删除正文，复制和同步依然保留全文。
            let hideLevel = 0;
            state.doc.forEach((node, pos) => {
              if (hideLevel && node.type.name === 'heading' && node.attrs.level <= hideLevel)
                hideLevel = 0;
              if (hideLevel)
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, { class: 'note-fold-hidden' })
                );
              else if (node.type.name === 'heading' && node.attrs.collapsed)
                hideLevel = node.attrs.level;
            });
            return DecorationSet.create(state.doc, decorations);
          },
          handleDrop(view, event) {
            const value = event.dataTransfer?.getData('application/x-pastepaw-block');
            if (!value) return false;
            const source = Number(value);
            const target = view.posAtCoords({ left: event.clientX, top: event.clientY });
            const node = view.state.doc.nodeAt(source);
            if (!node || !target) return true;
            const $source = view.state.doc.resolve(source),
              $target = view.state.doc.resolve(target.pos);
            // 只在同一个父块内拖动，避免破坏表格或把列表项放到非法位置。
            const depth = $source.depth;
            if ($target.depth < depth || $target.start(depth) !== $source.start(depth)) return true;
            const dest = $target.before(depth + 1);
            if (dest >= source && dest <= source + node.nodeSize) return true;
            const tr = view.state.tr.delete(source, source + node.nodeSize);
            const mapped = tr.mapping.map(dest);
            tr.insert(mapped, node).setSelection(TextSelection.near(tr.doc.resolve(mapped + 1)));
            view.dispatch(tr.scrollIntoView());
            return true;
          },
        },
      }),
    ];
  },
});
