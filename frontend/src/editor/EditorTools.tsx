import { invoke } from '@tauri-apps/api/core';
import { Editor } from '@tiptap/core';
import { BubbleMenu } from '@tiptap/react/menus';
import {
  Bold,
  Italic,
  Underline,
  Strikethrough,
  Highlighter,
  Eraser,
  Link,
  Search,
  List,
  ListOrdered,
  CheckSquare,
  Code,
  Table,
  Quote,
  Minus,
  Paperclip,
  Image,
  ChevronUp,
  ChevronDown,
  Copy,
  Trash2,
  GripVertical,
  ChevronsUpDown,
  ExternalLink,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { TextSelection } from '@tiptap/pm/state';
import { insertFiles } from './assets';
import { toggleMixedList } from './lists';
import { activeBlock, blockAction, findMatches, searchKey } from './structure';

type Action = { id: string; label: string; icon: typeof Bold; run: () => void; active?: boolean };
export function EditorTools({ editor, noteId }: { editor: Editor; noteId: string | null }) {
  const { t } = useTranslation();
  const [, refresh] = useState(0);
  const [showFind, setShowFind] = useState(false);
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [linkText, setLinkText] = useState('');
  const linkRange = useRef({ from: 0, to: 0 });
  const fileInput = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const [slash, setSlash] = useState<{
    from: number;
    to: number;
    text: string;
    left: number;
    top: number;
  } | null>(null);
  const [choice, setChoice] = useState(0);
  const slashRef = useRef(slash);
  slashRef.current = slash;
  const [showInsert, setShowInsert] = useState(false);
  const matches = findMatches(editor, showFind ? query : '', matchCase);
  const current = matches.findIndex(
    (m) => m.from === editor.state.selection.from && m.to === editor.state.selection.to
  );
  const selectedBlock = activeBlock(editor);

  const openLink = () => {
    editor.chain().focus().extendMarkRange('link').run();
    linkRange.current = { from: editor.state.selection.from, to: editor.state.selection.to };
    setLinkText(editor.state.doc.textBetween(linkRange.current.from, linkRange.current.to));
    setLink(editor.getAttributes('link').href || 'https://');
  };
  const formats: Action[] = [
    {
      id: 'bold',
      label: t('notepad.editor.bold'),
      icon: Bold,
      run: () => {
        editor.chain().focus().toggleBold().run();
      },
      active: editor.isActive('bold'),
    },
    {
      id: 'italic',
      label: t('notepad.editor.italic'),
      icon: Italic,
      run: () => {
        editor.chain().focus().toggleItalic().run();
      },
      active: editor.isActive('italic'),
    },
    {
      id: 'underline',
      label: t('notepad.editor.underline'),
      icon: Underline,
      run: () => {
        editor.chain().focus().toggleUnderline().run();
      },
      active: editor.isActive('underline'),
    },
    {
      id: 'strike',
      label: t('notepad.editor.strike'),
      icon: Strikethrough,
      run: () => {
        editor.chain().focus().toggleStrike().run();
      },
      active: editor.isActive('strike'),
    },
    {
      id: 'highlight',
      label: t('notepad.editor.highlight'),
      icon: Highlighter,
      run: () => {
        editor.chain().focus().toggleHighlight().run();
      },
      active: editor.isActive('highlight'),
    },
    {
      id: 'code',
      label: t('notepad.editor.inlineCode'),
      icon: Code,
      run: () => {
        editor.chain().focus().toggleCode().run();
      },
      active: editor.isActive('code'),
    },
    {
      id: 'link',
      label: t('notepad.editor.editLink'),
      icon: Link,
      run: openLink,
      active: editor.isActive('link'),
    },
    {
      id: 'clear',
      label: t('notepad.editor.clearFormat'),
      icon: Eraser,
      run: () => {
        editor.chain().focus().unsetAllMarks().run();
      },
    },
  ];
  const inserts: Action[] = [
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      id: `h${level}`,
      label: t('notepad.editor.heading', { level }),
      icon: ChevronsUpDown,
      run: () => {
        editor
          .chain()
          .focus()
          .toggleHeading({ level: level as 1 | 2 | 3 | 4 | 5 | 6 })
          .run();
      },
    })),
    {
      id: 'paragraph',
      label: t('notepad.editor.paragraph'),
      icon: Eraser,
      run: () => {
        editor.chain().focus().setParagraph().run();
      },
    },
    {
      id: 'bulletList',
      label: t('notepad.editor.bulletList'),
      icon: List,
      run: () => {
        toggleMixedList(editor, 'bulletList');
      },
    },
    {
      id: 'orderedList',
      label: t('notepad.editor.orderedList'),
      icon: ListOrdered,
      run: () => {
        toggleMixedList(editor, 'orderedList');
      },
    },
    {
      id: 'taskList',
      label: t('notepad.editor.taskList'),
      icon: CheckSquare,
      run: () => {
        toggleMixedList(editor, 'taskList');
      },
    },
    {
      id: 'quote',
      label: t('notepad.editor.quote'),
      icon: Quote,
      run: () => {
        editor.chain().focus().toggleBlockquote().run();
      },
    },
    {
      id: 'codeBlock',
      label: t('notepad.editor.codeBlock'),
      icon: Code,
      run: () => {
        editor.chain().focus().toggleCodeBlock().run();
      },
    },
    {
      id: 'table',
      label: t('notepad.editor.table'),
      icon: Table,
      run: () => {
        editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      },
    },
    {
      id: 'divider',
      label: t('notepad.editor.divider'),
      icon: Minus,
      run: () => {
        editor.chain().focus().setHorizontalRule().run();
      },
    },
    {
      id: 'image',
      label: t('notepad.editor.image'),
      icon: Image,
      run: () => {
        if (fileInput.current) {
          fileInput.current.accept = 'image/png,image/jpeg,image/gif,image/webp';
          fileInput.current.click();
        }
      },
    },
    {
      id: 'attachment',
      label: t('notepad.editor.attachment'),
      icon: Paperclip,
      run: () => {
        if (fileInput.current) {
          fileInput.current.accept = '';
          fileInput.current.click();
        }
      },
    },
  ];
  const options = inserts.filter(
    (a) => !slash?.text || `${a.id} ${a.label}`.toLowerCase().includes(slash.text.toLowerCase())
  );
  const actionRef = useRef<() => void>();
  const execute = (action: Action) => {
    const range = slashRef.current;
    if (range) editor.chain().focus().deleteRange({ from: range.from, to: range.to }).run();
    setSlash(null);
    setShowInsert(false);
    action.run();
  };
  actionRef.current = () => {
    if (options[choice]) execute(options[choice]);
  };

  useEffect(() => {
    const update = () => {
      refresh((n) => n + 1);
      const { $from, empty } = editor.state.selection;
      const before = $from.parent.textBetween(0, $from.parentOffset, '', '\ufffc');
      const match =
        empty && $from.parent.type.name === 'paragraph' && before.match(/^\/([^\s/]{0,30})$/);
      if (match) {
        const coords = editor.view.coordsAtPos($from.pos);
        setSlash({
          from: $from.start(),
          to: $from.pos,
          text: match[1],
          left: Math.min(coords.left, window.innerWidth - 235),
          top: Math.min(coords.bottom + 5, window.innerHeight - 280),
        });
      } else setSlash(null);
    };
    editor.on('transaction', update);
    const keyboard = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && ['f', 'h', 'k'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key.toLowerCase() === 'k') openLink();
        else {
          setShowFind(true);
          requestAnimationFrame(() => findInput.current?.focus());
        }
        return;
      }
      if (!slashRef.current || e.isComposing) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSlash(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setChoice((n) =>
          Math.max(0, Math.min(options.length - 1, n + (e.key === 'ArrowDown' ? 1 : -1)))
        );
      } else if (e.key === 'Enter' && options.length) {
        e.preventDefault();
        e.stopPropagation();
        actionRef.current?.();
      }
    };
    editor.view.dom.addEventListener('keydown', keyboard, true);
    return () => {
      editor.off('transaction', update);
      editor.view.dom.removeEventListener('keydown', keyboard, true);
    };
  }, [editor, options.length]);
  useEffect(() => {
    setChoice(0);
  }, [slash?.text]);
  useEffect(() => {
    setLink(null);
    setSlash(null);
    setQuery('');
    setShowFind(false);
  }, [noteId]);
  useEffect(() => {
    editor.view.dispatch(
      editor.state.tr
        .setMeta(searchKey, { query: showFind ? query : '', caseSensitive: matchCase })
        .setMeta('addToHistory', false)
    );
  }, [editor, query, showFind, matchCase]);
  const locate = (index: number) => {
    if (!matches.length) return;
    const match = matches[(index + matches.length) % matches.length];
    // 定位前展开折叠块，保证命中的正文可见。
    const tr = editor.state.tr;
    tr.doc.descendants((n, pos) => {
      if (n.attrs.collapsed) tr.setNodeMarkup(pos, undefined, { ...n.attrs, collapsed: false });
    });
    tr.setSelection(TextSelection.create(tr.doc, match.from, match.to));
    editor.view.dispatch(tr.scrollIntoView());
  };
  const replace = (all: boolean) => {
    if (!matches.length) return;
    const chosen = all ? matches : [matches[current < 0 ? 0 : current]];
    const tr = editor.state.tr;
    [...chosen]
      .reverse()
      .forEach((m) =>
        replacement ? tr.insertText(replacement, m.from, m.to) : tr.delete(m.from, m.to)
      );
    editor.view.dispatch(tr.scrollIntoView());
  };
  const buttons = (actions: Action[]) =>
    actions.map((action) => (
      <button
        type="button"
        key={action.id}
        title={action.label}
        aria-label={action.label}
        aria-pressed={action.active}
        className={action.active ? 'is-active' : ''}
        onMouseDown={(e) => e.preventDefault()}
        onClick={action.run}
      >
        <action.icon size={14} />
      </button>
    ));
  const tableActions = [
    [t('notepad.editor.rowBefore'), () => editor.chain().focus().addRowBefore().run()],
    [t('notepad.editor.rowAfter'), () => editor.chain().focus().addRowAfter().run()],
    [t('notepad.editor.columnBefore'), () => editor.chain().focus().addColumnBefore().run()],
    [t('notepad.editor.columnAfter'), () => editor.chain().focus().addColumnAfter().run()],
    [t('notepad.editor.deleteRow'), () => editor.chain().focus().deleteRow().run()],
    [t('notepad.editor.deleteColumn'), () => editor.chain().focus().deleteColumn().run()],
    [t('notepad.editor.merge'), () => editor.chain().focus().mergeCells().run()],
    [t('notepad.editor.split'), () => editor.chain().focus().splitCell().run()],
    [t('notepad.editor.header'), () => editor.chain().focus().toggleHeaderRow().run()],
    [t('notepad.editor.deleteTable'), () => editor.chain().focus().deleteTable().run()],
  ] as const;
  return (
    <>
      <div className="note-tools">
        <div className="note-tool-group">{buttons(formats)}</div>
        <div className="note-tool-group">
          {buttons(
            inserts
              .filter((a) => ['bulletList', 'orderedList', 'taskList'].includes(a.id))
              .map((a) => ({ ...a, active: editor.isActive(a.id) }))
          )}
        </div>
        <div className="note-tool-group">
          <button
            type="button"
            title={t('notepad.editor.insertTip')}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowInsert(!showInsert)}
          >
            {t('notepad.editor.insert')} <ChevronDown size={12} />
          </button>
          <button
            type="button"
            aria-label={t('notepad.editor.find')}
            title={t('notepad.editor.findShortcut')}
            onClick={() => {
              setShowFind(!showFind);
              requestAnimationFrame(() => findInput.current?.focus());
            }}
          >
            <Search size={14} />
          </button>
        </div>
        <input
          type="file"
          hidden
          multiple
          ref={fileInput}
          onChange={(e) => {
            void insertFiles(editor, Array.from(e.target.files || []));
            e.target.value = '';
          }}
        />
      </div>
      {showInsert && (
        <div className="note-insert-panel">
          {inserts.map((a) => (
            <button
              type="button"
              key={a.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => execute(a)}
            >
              <a.icon size={14} />
              {a.label}
            </button>
          ))}
        </div>
      )}
      {showFind && (
        <div className="note-find" role="search">
          <input
            ref={findInput}
            aria-label={t('notepad.editor.findText')}
            placeholder={t('notepad.editor.findText')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') locate(current + (e.shiftKey ? -1 : 1));
              if (e.key === 'Escape') {
                e.stopPropagation();
                setShowFind(false);
              }
            }}
          />
          <span>{matches.length ? `${current + 1}/${matches.length}` : '0/0'}</span>
          <button
            type="button"
            title={t('notepad.editor.previous')}
            onClick={() => locate(current - 1)}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            title={t('notepad.editor.next')}
            onClick={() => locate(current + 1)}
          >
            <ChevronDown size={14} />
          </button>
          <label>
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(e) => setMatchCase(e.target.checked)}
            />
            {t('notepad.editor.caseSensitive')}
          </label>
          <input
            aria-label={t('notepad.editor.replaceWith')}
            placeholder={t('notepad.editor.replaceWith')}
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
          />
          <button type="button" onClick={() => replace(false)}>
            {t('notepad.editor.replace')}
          </button>
          <button type="button" onClick={() => replace(true)}>
            {t('notepad.editor.replaceAll')}
          </button>
          <button
            type="button"
            title={t('notepad.editor.closeFind')}
            onClick={() => setShowFind(false)}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="note-block-tools">
        <button
          type="button"
          draggable
          title={t('notepad.editor.drag')}
          onDragStart={(e) => {
            e.dataTransfer.setData('application/x-pastepaw-block', String(selectedBlock.pos));
            e.dataTransfer.effectAllowed = 'move';
          }}
        >
          <GripVertical size={13} />
        </button>
        <span>
          {selectedBlock.node.type.name === 'taskItem'
            ? t('notepad.editor.taskItem')
            : selectedBlock.node.type.name === 'listItem'
              ? t('notepad.editor.listItem')
              : t('notepad.editor.currentBlock')}
        </span>
        <button
          type="button"
          title={t('notepad.editor.moveUp')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => blockAction(editor, 'up')}
        >
          <ChevronUp size={13} />
        </button>
        <button
          type="button"
          title={t('notepad.editor.moveDown')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => blockAction(editor, 'down')}
        >
          <ChevronDown size={13} />
        </button>
        <button
          type="button"
          title={t('notepad.editor.duplicate')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => blockAction(editor, 'duplicate')}
        >
          <Copy size={13} />
        </button>
        <button
          type="button"
          title={t('notepad.editor.deleteBlock')}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => blockAction(editor, 'delete')}
        >
          <Trash2 size={13} />
        </button>
        {['heading', 'listItem', 'taskItem'].includes(selectedBlock.node.type.name) && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() =>
              editor
                .chain()
                .focus()
                .updateAttributes(selectedBlock.node.type.name, {
                  collapsed: !selectedBlock.node.attrs.collapsed,
                })
                .run()
            }
          >
            {selectedBlock.node.attrs.collapsed
              ? t('notepad.editor.expand')
              : t('notepad.editor.collapse')}
          </button>
        )}
        {editor.isActive('table') &&
          tableActions.map(([label, run]) => (
            <button type="button" key={label} onMouseDown={(e) => e.preventDefault()} onClick={run}>
              {label}
            </button>
          ))}
      </div>
      <BubbleMenu editor={editor} className="note-tools note-bubble">
        {buttons(formats)}
      </BubbleMenu>
      {slash && options.length > 0 && (
        <div className="note-slash" role="listbox" style={{ left: slash.left, top: slash.top }}>
          {options.map((a, i) => (
            <button
              type="button"
              role="option"
              aria-selected={choice === i}
              className={choice === i ? 'is-active' : ''}
              key={a.id}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => execute(a)}
            >
              <a.icon size={14} />
              {a.label}
            </button>
          ))}
        </div>
      )}
      {link !== null && (
        <div className="note-link-dialog" role="dialog" aria-label={t('notepad.editor.linkDialog')}>
          <label>
            {t('notepad.editor.displayText')}
            <input value={linkText} onChange={(e) => setLinkText(e.target.value)} />
          </label>
          <label>
            {t('notepad.editor.linkAddress')}
            <input
              autoFocus
              value={link}
              onChange={(e) => setLink(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setLink(null);
                }
              }}
            />
          </label>
          <div>
            <button
              type="button"
              onClick={() => {
                if (!/^(https?:\/\/|mailto:)/i.test(link)) {
                  toast.error(t('notepad.editor.invalidLink'));
                  return;
                }
                const { from, to } = linkRange.current;
                editor
                  .chain()
                  .focus()
                  .insertContentAt(
                    { from, to },
                    {
                      type: 'text',
                      text: linkText || link,
                      marks: [{ type: 'link', attrs: { href: link } }],
                    }
                  )
                  .run();
                setLink(null);
              }}
            >
              {t('notepad.editor.save')}
            </button>
            <button
              type="button"
              onClick={() => {
                editor.chain().focus().setTextSelection(linkRange.current).unsetLink().run();
                setLink(null);
              }}
            >
              {t('notepad.editor.unlink')}
            </button>
            <button
              type="button"
              onClick={() =>
                invoke('open_note_link', { url: link }).catch((err) => toast.error(String(err)))
              }
            >
              <ExternalLink size={13} />
              {t('notepad.editor.open')}
            </button>
            <button type="button" onClick={() => setLink(null)}>
              {t('notepad.editor.cancel')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
