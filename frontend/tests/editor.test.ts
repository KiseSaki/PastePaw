import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Editor } from '@tiptap/core';
import { noteExtensions } from '../src/editor/extensions';
import { liftMixedItem, toggleMixedList } from '../src/editor/lists';
import { markdownToHtml, tsvToTable } from '../src/editor/markdown';
import { htmlToMarkdown } from '../../shared/noteMarkdown.js';
import { blockAction, findMatches, searchKey } from '../src/editor/structure';

before(() => {
  const win = new JSDOM('', { pretendToBeVisual: true }).window;
  for (const key of [
    'window',
    'document',
    'DOMParser',
    'HTMLElement',
    'Element',
    'Node',
    'KeyboardEvent',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ])
    Object.defineProperty(globalThis, key, { value: (win as any)[key], configurable: true });
  Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true });
});
function editor(content: any = '<p>测试</p>') {
  return new Editor({ extensions: noteExtensions(), content, injectCSS: false });
}
const paragraph = (text: string) => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});
function list(type: string, labels: string[], child?: any) {
  return {
    type,
    attrs: type === 'orderedList' ? { start: 5 } : {},
    content: labels.map((text, i) => ({
      type: type === 'taskList' ? 'taskItem' : 'listItem',
      attrs: { checked: i === 0 },
      content: [paragraph(text), ...(i === 0 && child ? [child] : [])],
    })),
  };
}
function cursor(e: Editor, text: string) {
  e.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) e.commands.setTextSelection(pos + text.length);
  });
}

test('三种列表六个方向的转换均保留父项、子项、格式和层级', () => {
  const types = ['bulletList', 'orderedList', 'taskList'] as const;
  for (const from of types)
    for (const to of types) {
      if (from === to) continue;
      const e = editor({
        type: 'doc',
        content: [
          list('taskList', ['父', '父2'], list(from, ['子1', '子2'], list('bulletList', ['孙']))),
        ],
      });
      cursor(e, '子1');
      assert.equal(toggleMixedList(e, to), true);
      const doc = e.getJSON();
      assert.equal(
        doc.content?.filter((n) => n.type !== 'paragraph' || n.content?.length).length,
        1
      );
      assert.equal(doc.content?.[0].content?.[0].content?.[1].type, to, `${from} → ${to}`);
      assert.equal(
        doc.content?.[0].content?.[0].content?.[1].content?.[0].content?.[1].content?.[0]
          .content?.[0].content?.[0].text,
        '孙'
      );
      e.commands.undo();
      assert.equal(e.getJSON().content?.[0].content?.[0].content?.[1].type, from);
      e.destroy();
    }
});
test('待办父项中的普通列表 Tab 操作最近项，Shift+Tab 跨类型提升保留后续项', () => {
  const e = editor({
    type: 'doc',
    content: [list('taskList', ['父'], list('bulletList', ['子1', '子2', '子3']))],
  });
  cursor(e, '子2');
  e.commands.keyboardShortcut('Tab');
  assert.equal(
    e.getJSON().content?.[0].content?.[0].content?.[1].content?.[0].content?.[1].type,
    'bulletList'
  );
  e.commands.undo();
  cursor(e, '子2');
  assert.equal(liftMixedItem(e), true);
  const items = e.getJSON().content?.[0].content!;
  assert.equal(items.length, 2);
  assert.equal(items[0].content?.[0].content?.[0].text, '父');
  assert.equal(items[1].type, 'taskItem');
  assert.equal(items[1].content?.[0].content?.[0].text, '子2');
  assert.equal(items[1].content?.[1].content?.[0].content?.[0].content?.[0].text, '子3');
  e.destroy();
});
test('Markdown 保留混合待办、起始编号、代码语言和缩进、空行、引用与表格', () => {
  const html =
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox"></label><div><p>父</p><ol start="5"><li><p>子</p></li></ol></div></li></ul><pre><code class="language-python">    print(1)\n\n\n    print(2)\n</code></pre><blockquote><p>第一行</p><p>第二行</p></blockquote><table><tr><th>列1</th><th>列2</th></tr><tr><td>甲</td><td>乙</td></tr></table>';
  const md = htmlToMarkdown(html);
  assert.match(md, /- \[x\] 父\n {2}5\. 子/);
  assert.match(md, /```python\n {4}print\(1\)\n\n\n {4}print\(2\)\n```/);
  assert.match(md, /> 第二行/);
  assert.match(md, /\| 列1 \| 列2 \|/);
  const e = editor(markdownToHtml(md));
  assert.equal(e.getJSON().content?.[0].type, 'taskList');
  assert.equal(e.getJSON().content?.[0].content?.[0].content?.[1].attrs?.start, 5);
  assert.equal(e.getJSON().content?.[1].attrs?.language, 'python');
  assert.equal(e.getJSON().content?.[3].type, 'table');
  e.destroy();
});
test('TSV 生成可编辑表格，HTML 和危险链接不能执行', () => {
  const e = editor(tsvToTable('甲\t乙\n<script>\t丁'));
  assert.equal(e.getJSON().content?.[0].content?.length, 2);
  assert.match(e.getText(), /<script>/);
  assert.doesNotMatch(
    markdownToHtml('[链接](javascript:alert(1))<script>alert(1)</script>'),
    /href="javascript:|<script>/
  );
  e.destroy();
});
test('同级混合任务和普通 Markdown 列表拆分后仍保持顺序，列表内代码块可回读', () => {
  const e = editor(markdownToHtml('- 普通\n- [x] 已完成\n- 普通二'));
  assert.deepEqual(
    e
      .getJSON()
      .content?.filter((n) => n.type !== 'paragraph')
      .map((n) => n.type),
    ['bulletList', 'taskList', 'bulletList']
  );
  const md = htmlToMarkdown(
    '<ul><li><p>代码说明</p><pre><code class="language-js">  const x = 1;\n</code></pre></li></ul>'
  );
  e.commands.setContent(markdownToHtml(md));
  assert.equal(e.getJSON().content?.[0].content?.[0].content?.[1].type, 'codeBlock');
  e.destroy();
});
test('跨文字格式查找定位正确，替换和块移动可撤销', () => {
  const e = editor('<p>ab<strong>cd</strong>ab</p><p>第二块</p>');
  assert.deepEqual(findMatches(e, 'bc'), [{ from: 2, to: 4 }]);
  const matches = findMatches(e, 'ab');
  const tr = e.state.tr;
  matches.reverse().forEach((m) => tr.insertText('X', m.from, m.to));
  e.view.dispatch(tr);
  assert.equal(e.state.doc.firstChild?.textContent, 'XcdX');
  e.commands.undo();
  cursor(e, '第二块');
  blockAction(e, 'up');
  assert.equal(e.state.doc.firstChild?.textContent, '第二块');
  e.commands.undo();
  assert.equal(e.state.doc.firstChild?.textContent, 'abcdab');
  e.destroy();
});
test('折叠仅改变展示，复制全文和保存重载保留隐藏正文', () => {
  const e = editor('<h2 data-collapsed="true">标题</h2><p>隐藏正文</p><h2>下一节</h2>');
  assert.ok(e.getHTML().includes('data-collapsed="true"'));
  e.view.dispatch(e.state.tr.setMeta(searchKey, { query: '正文', caseSensitive: false }));
  assert.match(htmlToMarkdown(e.getHTML()), /隐藏正文/);
  assert.equal(e.view.dom.querySelectorAll('.note-fold-hidden').length, 1);
  e.destroy();
});
test('附件引用保存重载保持哈希和显示名称，不把本地路径写入 HTML', () => {
  const hash = 'a'.repeat(64);
  const e = editor(
    `<div data-type="attachment" data-asset="${hash}" data-name="文件.txt" data-mime="application/octet-stream" data-size="4">文件.txt</div>`
  );
  assert.equal(e.getJSON().content?.[0].attrs?.asset, hash);
  assert.match(htmlToMarkdown(e.getHTML()), /\[文件.txt\]\(pastepaw-asset:/);
  assert.doesNotMatch(e.getHTML(), /[A-Z]:\\/);
  e.destroy();
});
