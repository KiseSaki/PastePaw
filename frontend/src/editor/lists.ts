import { Editor, Extension } from '@tiptap/core';
import { Fragment, Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

export type ListKind = 'bulletList' | 'orderedList' | 'taskList';
export function nearestItem(pos: ResolvedPos): number {
  for (let d = pos.depth; d > 0; d--) {
    if (['listItem', 'taskItem'].includes(pos.node(d).type.name)) return d;
  }
  return -1;
}
const nodes = (node: PMNode) => {
  const result: PMNode[] = [];
  node.forEach((n) => result.push(n));
  return result;
};

export function toggleMixedList(editor: Editor, kind: ListKind): boolean {
  const { $from } = editor.state.selection;
  const depth = nearestItem($from);
  if (depth < 0)
    return editor
      .chain()
      .focus()
      .toggleList(kind, kind === 'taskList' ? 'taskItem' : 'listItem')
      .run();
  const list = $from.node(depth - 1);
  if (list.type.name === kind) return liftMixedItem(editor);
  const itemType = editor.schema.nodes[kind === 'taskList' ? 'taskItem' : 'listItem'];
  const content = nodes(list).map((item) =>
    itemType.create(
      kind === 'taskList' ? { ...item.attrs, checked: item.attrs.checked ?? false } : item.attrs,
      item.content,
      item.marks
    )
  );
  const replacement = editor.schema.nodes[kind].create(
    kind === 'orderedList' ? { start: list.attrs.start || 1 } : {},
    content
  );
  const from = $from.before(depth - 1);
  const tr = editor.state.tr.replaceWith(from, from + list.nodeSize, replacement);
  tr.setSelection(
    TextSelection.create(tr.doc, editor.state.selection.from, editor.state.selection.to)
  );
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function liftMixedItem(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  const depth = nearestItem($from);
  if (depth < 0) return false;
  const item = $from.node(depth),
    list = $from.node(depth - 1);
  const parentItem = depth > 2 ? $from.node(depth - 2) : null;
  if (!parentItem || !['taskItem', 'listItem'].includes(parentItem.type.name)) {
    return editor.commands.liftListItem(item.type.name);
  }
  if (nearestItem($to) !== depth || $from.before(depth - 1) !== $to.before(depth - 1)) return false;
  const first = $from.index(depth - 1),
    last = $to.index(depth - 1);
  const siblings = nodes(list);
  const moved = siblings
    .slice(first, last + 1)
    .map((n) =>
      parentItem.type.create({ ...n.attrs, checked: n.attrs.checked ?? false }, n.content, n.marks)
    );
  // 后续同级项随提升后的最后一项保留为子列表，保持原阅读顺序。
  if (last + 1 < siblings.length) {
    const tail = list.type.create(list.attrs, siblings.slice(last + 1));
    const end = moved.length - 1;
    moved[end] = moved[end].copy(moved[end].content.append(Fragment.from(tail)));
  }
  const parentChildren = nodes(parentItem);
  const listIndex = $from.index(depth - 2);
  if (first) parentChildren[listIndex] = list.copy(Fragment.from(siblings.slice(0, first)));
  else parentChildren.splice(listIndex, 1);
  const updatedParent = parentItem.copy(Fragment.from(parentChildren));
  const outer = $from.node(depth - 3),
    outerChildren = nodes(outer);
  const parentIndex = $from.index(depth - 3);
  outerChildren.splice(parentIndex, 1, updatedParent, ...moved);
  const from = $from.before(depth - 3);
  const replacement = outer.copy(Fragment.from(outerChildren));
  const relative = editor.state.selection.from - $from.before(depth);
  const tr = editor.state.tr.replaceWith(from, from + outer.nodeSize, replacement);
  const pos =
    from +
    1 +
    outerChildren.slice(0, parentIndex + 1).reduce((sum, n) => sum + n.nodeSize, 0) +
    relative;
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(pos, tr.doc.content.size))));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export const MixedListKeyboard = Extension.create({
  name: 'mixedListKeyboard',
  priority: 1100,
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const depth = nearestItem(this.editor.state.selection.$from);
        if (depth < 0) return this.editor.commands.insertContent('  ');
        this.editor.commands.sinkListItem(this.editor.state.selection.$from.node(depth).type.name);
        return true;
      },
      'Shift-Tab': () => {
        liftMixedItem(this.editor);
        return true;
      },
      'Mod-Shift-7': () => toggleMixedList(this.editor, 'orderedList'),
      'Mod-Shift-8': () => toggleMixedList(this.editor, 'bulletList'),
      'Mod-Shift-9': () => toggleMixedList(this.editor, 'taskList'),
      Enter: () => {
        const { $from, empty } = this.editor.state.selection;
        const depth = nearestItem($from);
        if (depth < 0) return false;
        const item = $from.node(depth);
        if (empty && item.childCount === 1 && !item.firstChild?.content.size)
          return liftMixedItem(this.editor);
        return this.editor.commands.splitListItem(item.type.name);
      },
      Backspace: () => {
        const { state } = this.editor;
        const { $from, empty } = state.selection;
        const d = nearestItem($from);
        if (!empty || d < 0) return false;
        const item = $from.node(d),
          list = $from.node(d - 1);
        // 有子块或附件的列表项不能作为空项删除。
        if (
          item.childCount !== 1 ||
          item.firstChild?.type.name !== 'paragraph' ||
          item.firstChild.content.size
        )
          return false;
        if (list.childCount > 1 && $from.index(d - 1) < list.childCount - 1) {
          const from = $from.before(d);
          const tr = state.tr.delete(from, $from.after(d));
          tr.setSelection(TextSelection.near(tr.doc.resolve(from)));
          this.editor.view.dispatch(tr);
          return true;
        }
        return liftMixedItem(this.editor);
      },
    };
  },
});
