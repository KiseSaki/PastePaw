import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Extension, wrappingInputRule } from '@tiptap/core';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskItem from '@tiptap/extension-task-item';
import TaskList from '@tiptap/extension-task-list';
import { DOMSerializer } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { clsx } from 'clsx';
import {
  Bold as BoldIcon,
  CheckCircle2,
  CircleDot,
  Clock,
  Code as CodeIcon,
  Copy,
  CornerDownLeft,
  Minus as DividerIcon,
  Heading1,
  Heading2,
  List as ListIcon,
  Menu,
  Minus,
  ListOrdered as OrderedListIcon,
  Pin,
  PinOff,
  Plus,
  Search,
  Sliders,
  StickyNote,
  Strikethrough as StrikeIcon,
  CheckSquare as TaskIcon,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Toaster, toast } from 'sonner';
import { useLanguage } from '../hooks/useLanguage';
import { useTheme } from '../hooks/useTheme';
import { NOTE_COLORS, NoteItem, Settings } from '../types';
import {
  ensureHtmlContent,
  extractPlainTextPreview,
  htmlToMarkdown,
} from '../utils/notepadMarkdown';

// Extend TaskItem to support typing [] + space or [ ] + space directly without leading '-'
const CustomTaskItem = TaskItem.extend({
  addInputRules() {
    return [
      ...(this.parent?.() || []),
      wrappingInputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        type: this.type,
        getAttributes: (match) => ({
          checked: match[1].toLowerCase() === 'x',
        }),
      }),
    ];
  },
});

// Custom keyboard handling for Lists & Tabs:
// 1. Tab / Shift-Tab: Sinks/lifts items without escaping to bottom buttons.
//    In regular text, Tab inserts 2 spaces.
// 2. Smart Backspace: When deleting an empty list item that has subsequent siblings
//    (e.g. - 1xxx is cleared, followed by - 2xxx), deletes the empty item directly
//    instead of lifting it, preserving 2xxx's nested indentation.
const ListKeyboardExtension = Extension.create({
  name: 'listKeyboardExtension',
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive('taskItem')) {
          editor.commands.sinkListItem('taskItem');
          return true; // Always consume Tab to prevent focus jumping to bottom buttons
        }
        if (editor.isActive('listItem')) {
          editor.commands.sinkListItem('listItem');
          return true; // Always consume Tab to prevent focus jumping to bottom buttons
        }
        editor.commands.insertContent('  ');
        return true;
      },
      'Shift-Tab': ({ editor }) => {
        if (editor.isActive('taskItem')) {
          editor.commands.liftListItem('taskItem');
          return true; // Always consume Shift-Tab
        }
        if (editor.isActive('listItem')) {
          editor.commands.liftListItem('listItem');
          return true; // Always consume Shift-Tab
        }
        return true;
      },
      Backspace: ({ editor }) => {
        const { state, dispatch } = editor.view;
        const { selection } = state;
        if (!selection.empty) return false;

        const { $from } = selection;
        let itemDepth = -1;
        for (let d = $from.depth; d > 0; d--) {
          const nodeName = $from.node(d).type.name;
          if (nodeName === 'listItem' || nodeName === 'taskItem') {
            itemDepth = d;
            break;
          }
        }

        if (itemDepth < 0) return false;

        const listItem = $from.node(itemDepth);
        const listParent = $from.node(itemDepth - 1);

        // Check if cursor is in an empty list item
        const isEmptyItem = listItem.textContent.trim() === '';
        if (isEmptyItem && listParent) {
          const indexInList = $from.index(itemDepth - 1);
          // If there are subsequent siblings in this list (e.g. 1xxx is empty, followed by 2xxx)
          if (listParent.childCount > 1 && indexInList < listParent.childCount - 1) {
            const itemStart = $from.before(itemDepth);
            const itemEnd = $from.after(itemDepth);
            const tr = state.tr.delete(itemStart, itemEnd);
            tr.setSelection(TextSelection.create(tr.doc, Math.min(itemStart + 1, tr.doc.content.size)));
            dispatch(tr);
            return true;
          }
        }

        return false;
      },
    };
  },
});

// Completely reset undo/redo history for ProseMirror history plugin
function resetEditorHistory(editor: any) {
  if (!editor || editor.isDestroyed) return;
  const historyPlugin = editor.state.plugins.find(
    (p: any) =>
      p.key === 'history$' ||
      p.key?.startsWith('history$') ||
      p.spec?.key?.name === 'history' ||
      p.spec?.config?.depth !== undefined
  );

  if (historyPlugin && historyPlugin.spec?.state?.init) {
    const emptyState = historyPlugin.spec.state.init(null, editor.state);
    let tr = editor.state.tr.setMeta(historyPlugin, { historyState: emptyState });
    if (historyPlugin.key) {
      tr = tr.setMeta(historyPlugin.key, { historyState: emptyState });
    }
    if (historyPlugin.spec?.key) {
      tr = tr.setMeta(historyPlugin.spec.key, { historyState: emptyState });
    }
    editor.view.dispatch(tr);
  }
}

export function NotepadWindow() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const effectiveTheme = useTheme(settings?.theme || 'system');
  useLanguage(settings?.language);

  const [notes, setNotes] = useState<NoteItem[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('pastepaw_notepad_sidebar_width');
    if (saved) {
      const parsed = Number(saved);
      if (!isNaN(parsed) && parsed >= 48 && parsed <= 420) return parsed;
    }
    return 208;
  });
  const [isResizing, setIsResizing] = useState(false);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(true);
  const [opacity, setOpacity] = useState(98);
  const [showOpacitySlider, setShowOpacitySlider] = useState(false);

  // Auto-hide controls when not hovered and not focused
  const [isHovered, setIsHovered] = useState(false);
  const [isFocused, setIsFocused] = useState(() =>
    typeof document !== 'undefined' ? document.hasFocus() : true
  );

  useEffect(() => {
    const handleMouseEnter = () => setIsHovered(true);
    const handleMouseLeave = (e: MouseEvent) => {
      if (
        !e.relatedTarget &&
        (e.clientY <= 0 ||
          e.clientX <= 0 ||
          e.clientX >= window.innerWidth ||
          e.clientY >= window.innerHeight)
      ) {
        setIsHovered(false);
      }
    };
    const handleMouseMove = () => {
      setIsHovered(true);
    };

    const handleFocus = () => setIsFocused(true);
    const handleBlur = () => {
      setIsFocused(false);
      setIsHovered(false);
    };

    window.addEventListener('mouseenter', handleMouseEnter);
    window.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('mouseenter', handleMouseEnter);
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  const showChrome = isHovered || isFocused || showOpacitySlider || isResizing;

  // Editor states
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [color, setColor] = useState('default');
  const [isPinned, setIsPinned] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [filterStatus, setFilterStatus] = useState<'active' | 'completed'>('active');
  const [isSaving, setIsSaving] = useState(false);

  const activeNoteRef = useRef<NoteItem | null>(null);
  const titleRef = useRef(title);
  titleRef.current = title;
  const colorRef = useRef(color);
  colorRef.current = color;

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<{ id: string; title: string; content: string; color: string } | null>(null);
  const opacityRef = useRef<HTMLDivElement>(null);

  // Immediately flushes any pending auto-save before switching notes
  const flushPendingSave = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    const pending = pendingSaveRef.current;
    if (!pending) return;
    pendingSaveRef.current = null;

    try {
      const updated = await invoke<NoteItem>('update_note', {
        id: pending.id,
        title: pending.title.trim() || null,
        content: pending.content,
        color: pending.color,
      });
      if (activeNoteRef.current?.id === updated.id) {
        activeNoteRef.current = updated;
      }
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
    } catch (err) {
      console.error('Failed to flush pending auto-save:', err);
    } finally {
      setIsSaving(false);
    }
  }, []);

  // Debounced auto-save targeting a specific noteId
  const triggerAutoSave = useCallback((targetNoteId: string, newTitle: string, newContent: string, newColor: string) => {
    if (!targetNoteId) return;

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    pendingSaveRef.current = {
      id: targetNoteId,
      title: newTitle,
      content: newContent,
      color: newColor,
    };

    setIsSaving(true);
    saveTimeoutRef.current = setTimeout(async () => {
      const pending = pendingSaveRef.current;
      if (!pending || pending.id !== targetNoteId) {
        setIsSaving(false);
        return;
      }
      pendingSaveRef.current = null;

      try {
        const updated = await invoke<NoteItem>('update_note', {
          id: targetNoteId,
          title: newTitle.trim() || null,
          content: newContent,
          color: newColor,
        });
        if (activeNoteRef.current?.id === targetNoteId) {
          activeNoteRef.current = updated;
        }
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      } catch (err) {
        console.error('Failed to auto-save note:', err);
      } finally {
        setIsSaving(false);
      }
    }, 300);
  }, []);

  // Tiptap Editor Instance
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: {
          levels: [1, 2, 3],
        },
        bulletList: {
          keepMarks: true,
          keepAttributes: false,
        },
        orderedList: {
          keepMarks: true,
          keepAttributes: false,
        },
      }),
      TaskList.configure({
        HTMLAttributes: {
          'data-type': 'taskList',
        },
      }),
      CustomTaskItem.configure({
        nested: true,
        HTMLAttributes: {
          'data-type': 'taskItem',
        },
      }),
      ListKeyboardExtension,
      Placeholder.configure({
        placeholder: t('notepad.contentPlaceholder') || '输入便签内容，支持 Markdown (如 - 列表, 1. 列表, [] 待办, **加粗**)...',
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        defaultProtocol: 'https',
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap ProseMirror focus:outline-none min-h-[140px]',
      },
      handleDOMEvents: {
        copy: (view, event) => {
          const { selection } = view.state;
          if (selection.empty) return false;

          try {
            const slice = selection.content();
            const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content);
            const div = document.createElement('div');
            div.appendChild(fragment);
            const html = div.innerHTML;
            const md = htmlToMarkdown(html);

            if (event.clipboardData) {
              event.clipboardData.clearData();
              event.clipboardData.setData('text/plain', md);
              event.clipboardData.setData('text/html', html);
              event.preventDefault();
              return true;
            }
          } catch (err) {
            console.error('Custom copy failed:', err);
          }
          return false;
        },
        cut: (view, event) => {
          const { selection } = view.state;
          if (selection.empty) return false;

          try {
            const slice = selection.content();
            const fragment = DOMSerializer.fromSchema(view.state.schema).serializeFragment(slice.content);
            const div = document.createElement('div');
            div.appendChild(fragment);
            const html = div.innerHTML;
            const md = htmlToMarkdown(html);

            if (event.clipboardData) {
              event.clipboardData.clearData();
              event.clipboardData.setData('text/plain', md);
              event.clipboardData.setData('text/html', html);
              view.dispatch(view.state.tr.deleteSelection());
              event.preventDefault();
              return true;
            }
          } catch (err) {
            console.error('Custom cut failed:', err);
          }
          return false;
        },
      },
    },
    content: ensureHtmlContent(content),
    onUpdate: ({ editor: currentEditor }) => {
      const currentNote = activeNoteRef.current;
      if (!currentNote) return;

      const html = currentEditor.getHTML();
      setContent(html);
      triggerAutoSave(currentNote.id, titleRef.current, html, colorRef.current);
    },
  });

  // Load Settings and initial Always on Top
  useEffect(() => {
    invoke<Settings>('get_settings').then(setSettings).catch(console.error);
    const unlistenSettings = listen<Settings>('settings-changed', (event) => {
      setSettings(event.payload);
    });

    invoke<boolean>('get_notepad_always_on_top')
      .then((val) => {
        setIsAlwaysOnTop(val);
        getCurrentWindow().setAlwaysOnTop(val).catch(console.error);
      })
      .catch(console.error);

    return () => {
      unlistenSettings.then((f) => f());
    };
  }, []);

  // Sync initial always-on-top
  useEffect(() => {
    const win = getCurrentWindow();
    win.setAlwaysOnTop(isAlwaysOnTop).catch(console.error);
  }, [isAlwaysOnTop]);

  // Flush pending auto-save on unmount
  useEffect(() => {
    return () => {
      if (pendingSaveRef.current) {
        const pending = pendingSaveRef.current;
        invoke('update_note', {
          id: pending.id,
          title: pending.title.trim() || null,
          content: pending.content,
          color: pending.color,
        }).catch(console.error);
      }
    };
  }, []);

  // Load Notes
  const loadNotes = useCallback(async (query: string = '') => {
    try {
      const data = await invoke<NoteItem[]>('get_notes', { query: query.trim() || null });
      setNotes(data);
      return data;
    } catch (err) {
      console.error('Failed to load notes:', err);
      return [];
    }
  }, []);

  // Select note
  const selectNote = useCallback(
    async (note: NoteItem) => {
      // 1. If switching to a different note, immediately flush any pending save for the previous note
      if (pendingSaveRef.current && pendingSaveRef.current.id !== note.id) {
        await flushPendingSave();
      }

      activeNoteRef.current = note;
      setSelectedNoteId(note.id);
      const cleanTitle =
        note.title && !note.title.startsWith('<') && note.title !== 'Untitled Note'
          ? note.title.trim()
          : '';
      setTitle(cleanTitle);
      titleRef.current = cleanTitle;
      setContent(note.content);
      setColor(note.color || 'default');
      colorRef.current = note.color || 'default';
      setIsPinned(note.is_pinned);
      setIsCompleted(Boolean(note.is_completed));
      if (editor && !editor.isDestroyed) {
        editor.commands.setContent(ensureHtmlContent(note.content), { emitUpdate: false });
        resetEditorHistory(editor);
      }
    },
    [editor, flushPendingSave]
  );

  // Create new note
  const handleCreateNote = useCallback(async () => {
    if (pendingSaveRef.current) {
      await flushPendingSave();
    }
    try {
      const newNote = await invoke<NoteItem>('create_note', {
        title: null,
        content: '',
        color: 'default',
      });
      setNotes((prev) => [newNote, ...prev]);
      await selectNote(newNote);
      if (editor && !editor.isDestroyed) {
        editor.commands.clearContent(false);
        resetEditorHistory(editor);
        editor.commands.focus();
      }
    } catch (err) {
      console.error('Failed to create note:', err);
      toast.error(t('notepad.createFailed'));
    }
  }, [editor, selectNote, flushPendingSave, t]);

  useEffect(() => {
    loadNotes(searchQuery).then((loadedNotes) => {
      const urlParams = new URLSearchParams(window.location.search);
      const targetNoteId = urlParams.get('noteId');

      if (targetNoteId && loadedNotes.some((n) => n.id === targetNoteId)) {
        selectNote(loadedNotes.find((n) => n.id === targetNoteId)!);
      } else if (loadedNotes.length > 0 && !activeNoteRef.current) {
        selectNote(loadedNotes[0]);
      } else if (loadedNotes.length === 0 && !activeNoteRef.current) {
        handleCreateNote();
      }
    });
  }, [loadNotes, searchQuery, selectNote, handleCreateNote]);

  // Listen for backend / multi-window note change events
  useEffect(() => {
    const unlistenNotes = listen<any>('notes-changed', () => {
      loadNotes(searchQuery);
    });

    const unlistenSelect = listen<string>('select-note', (event) => {
      const noteId = event.payload;
      invoke<NoteItem>('get_note', { id: noteId })
        .then((n) => selectNote(n))
        .catch(console.error);
    });

    return () => {
      unlistenNotes.then((f) => f());
      unlistenSelect.then((f) => f());
    };
  }, [loadNotes, searchQuery, selectNote]);

  // Title change
  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    titleRef.current = newTitle;
    const currentId = activeNoteRef.current?.id;
    if (currentId) {
      const currentContent = editor && !editor.isDestroyed ? editor.getHTML() : content;
      triggerAutoSave(currentId, newTitle, currentContent, colorRef.current);
    }
  };

  // Color change
  const handleColorChange = (newColor: string) => {
    setColor(newColor);
    colorRef.current = newColor;
    const currentId = activeNoteRef.current?.id;
    if (currentId) {
      const currentContent = editor && !editor.isDestroyed ? editor.getHTML() : content;
      triggerAutoSave(currentId, titleRef.current, currentContent, newColor);
    }
  };

  // Delete note
  const handleDeleteNote = async (id: string) => {
    if (pendingSaveRef.current && pendingSaveRef.current.id === id) {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }
      pendingSaveRef.current = null;
    }
    try {
      await invoke('delete_note', { id });
      const remaining = notes.filter((n) => n.id !== id);
      setNotes(remaining);

      if (selectedNoteId === id) {
        if (remaining.length > 0) {
          selectNote(remaining[0]);
        } else {
          handleCreateNote();
        }
      }
      toast.success(t('notepad.noteDeleted'));
    } catch (err) {
      console.error('Failed to delete note:', err);
      toast.error(t('notepad.deleteFailed'));
    }
  };

  // Toggle Pin
  const handleTogglePin = async (id: string) => {
    try {
      const updated = await invoke<NoteItem>('toggle_pin_note', { id });
      setNotes((prev) =>
        prev
          .map((n) => (n.id === updated.id ? updated : n))
          .sort((a, b) => (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0))
      );
      if (selectedNoteId === id) {
        setIsPinned(updated.is_pinned);
      }
    } catch (err) {
      console.error('Failed to toggle pin:', err);
    }
  };

  // Toggle Complete
  const handleToggleComplete = async (id: string) => {
    try {
      const newCompleted = await invoke<boolean>('toggle_complete_note', { id });
      setNotes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_completed: newCompleted } : n))
      );
      if (selectedNoteId === id) {
        setIsCompleted(newCompleted);
      }
      toast.success(newCompleted ? t('notepad.completed') : t('notepad.activeNotes'));
    } catch (err) {
      console.error('Failed to toggle complete:', err);
    }
  };

  // Clear Completed Notes
  const handleClearCompleted = async () => {
    if (!window.confirm(t('notepad.clearCompletedConfirm'))) return;
    try {
      const count = await invoke<number>('clear_completed_notes');
      setNotes((prev) => {
        const remaining = prev.filter((n) => !n.is_completed);
        if (activeNoteRef.current?.is_completed) {
          if (remaining.length > 0) {
            selectNote(remaining[0]);
          } else {
            handleCreateNote();
          }
        }
        return remaining;
      });
      toast.success(`${t('notepad.clearCompleted')}: ${count}`);
    } catch (err) {
      console.error('Failed to clear completed notes:', err);
    }
  };

  // Parse task completion progress for preview
  const getNoteTaskProgress = useCallback((contentStr: string) => {
    if (
      !contentStr ||
      (!contentStr.includes('taskItem') &&
        !contentStr.includes('[ ]') &&
        !contentStr.includes('[x]') &&
        !contentStr.includes('[X]'))
    ) {
      return null;
    }
    const htmlMatches = contentStr.match(/<li[^>]*data-type="taskItem"[^>]*>/gi);
    if (htmlMatches && htmlMatches.length > 0) {
      const checkedMatches =
        contentStr.match(/<li[^>]*data-type="taskItem"[^>]*data-checked="true"[^>]*>/gi) || [];
      return {
        checked: checkedMatches.length,
        total: htmlMatches.length,
      };
    }
    const mdMatches = contentStr.match(/\[([ xX])\]/g);
    if (mdMatches && mdMatches.length > 0) {
      const mdChecked = contentStr.match(/\[[xX]\]/g) || [];
      return {
        checked: mdChecked.length,
        total: mdMatches.length,
      };
    }
    return null;
  }, []);

  const activeCount = useMemo(() => notes.filter((n) => !n.is_completed).length, [notes]);
  const completedCount = useMemo(() => notes.filter((n) => n.is_completed).length, [notes]);

  const filteredNotes = useMemo(() => {
    return notes.filter((note) => {
      // 1. Completion filter
      if (filterStatus === 'active' && note.is_completed) return false;
      if (filterStatus === 'completed' && !note.is_completed) return false;

      // 2. Query filter
      if (!searchQuery.trim()) return true;
      const q = searchQuery.toLowerCase().trim();
      const titleMatch = (note.title || '').toLowerCase().includes(q);
      const contentMatch = extractPlainTextPreview(note.content, 9999)
        .toLowerCase()
        .includes(q);
      return titleMatch || contentMatch;
    });
  }, [notes, filterStatus, searchQuery]);

  // Copy full note (serialized as Markdown)
  const handleCopyAll = async () => {
    const md = htmlToMarkdown(content);
    if (!md) {
      toast.info(t('notepad.emptyNote'));
      return;
    }
    try {
      await navigator.clipboard.writeText(md);
      toast.success(t('notepad.copiedToClipboard'));
    } catch (err) {
      console.error('Failed to copy note:', err);
    }
  };

  // Paste to application (serialized as Markdown)
  const handlePasteToApp = async () => {
    const md = htmlToMarkdown(content);
    if (!md) {
      toast.info(t('notepad.emptyNote'));
      return;
    }
    try {
      await invoke('paste_note', { content: md });
    } catch (err) {
      console.error('Failed to paste note:', err);
    }
  };

  // Toggle Always on top
  const handleToggleAlwaysOnTop = async () => {
    const nextState = !isAlwaysOnTop;
    setIsAlwaysOnTop(nextState);
    const win = getCurrentWindow();
    await win.setAlwaysOnTop(nextState);
    invoke('set_notepad_always_on_top', { enabled: nextState }).catch(console.error);
    toast.info(nextState ? t('notepad.alwaysOnTop') : t('notepad.cancelAlwaysOnTop'));
  };

  // Window Minimize & Close
  const handleMinimize = async () => {
    const win = getCurrentWindow();
    await win.minimize();
  };

  const handleClose = async () => {
    if (pendingSaveRef.current) {
      await flushPendingSave();
    }
    const win = getCurrentWindow();
    await win.close();
  };

  // Toggle Sidebar
  const handleToggleSidebar = () => {
    if (isSidebarOpen) {
      setIsSidebarOpen(false);
    } else {
      setIsSidebarOpen(true);
      if (sidebarWidth < 48) {
        setSidebarWidth(208);
        localStorage.setItem('pastepaw_notepad_sidebar_width', '208');
      }
    }
  };

  // Mouse Drag Resizing handler for Divider
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);

    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      let newWidth = startWidth + delta;

      // Snapping: if dragged very small, collapse to 0
      if (newWidth < 48) {
        if (newWidth < 30) {
          setIsSidebarOpen(false);
        }
        newWidth = 48;
      } else {
        setIsSidebarOpen(true);
      }

      // Clamp max width
      const maxWidth = Math.min(420, Math.floor(window.innerWidth * 0.65));
      if (newWidth > maxWidth) newWidth = maxWidth;

      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      localStorage.setItem(
        'pastepaw_notepad_sidebar_width',
        String(Math.round(sidebarWidthRef.current))
      );
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  // Close opacity dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (opacityRef.current && !opacityRef.current.contains(e.target as Node)) {
        setShowOpacitySlider(false);
      }
    };
    if (showOpacitySlider) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showOpacitySlider]);

  // Keyboard Shortcuts inside Notepad Window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+N: New Note
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleCreateNote();
      }
      // Ctrl+Shift+C: Copy All
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        handleCopyAll();
      }
      // Ctrl+D: Toggle Complete
      if (e.ctrlKey && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        if (selectedNoteId) {
          handleToggleComplete(selectedNoteId);
        }
      }
      // Ctrl+Enter: Paste to app
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        handlePasteToApp();
      }
      // Escape: Close window
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [content, handleCreateNote, selectedNoteId, handleToggleComplete]);

  const currentColorObj = NOTE_COLORS.find((c) => c.id === color) || NOTE_COLORS[0];
  const plainText = extractPlainTextPreview(content, 999999);
  const charCount = plainText.length;
  const wordCount = plainText.trim() ? plainText.trim().split(/\s+/).length : 0;

  // Sidebar display mode tiers
  const isMini = isSidebarOpen && sidebarWidth < 100;
  const isCompact = isSidebarOpen && sidebarWidth >= 100 && sidebarWidth < 165;

  return (
    <div
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="relative flex h-screen w-screen select-none flex-col overflow-hidden border border-border/80 bg-background text-foreground shadow-2xl transition-all"
      style={{
        opacity: opacity / 100,
      }}
    >
      {/* Top Header / Drag Titlebar - relative z-30 ensures popovers float above main content */}
      <header
        className={clsx(
          'relative z-30 flex shrink-0 items-center justify-between bg-background/50 backdrop-blur-md transition-all duration-200 ease-in-out',
          showChrome
            ? 'h-9 border-b border-border/40 px-3 opacity-100'
            : 'h-0 border-b-0 px-3 py-0 opacity-0 overflow-hidden pointer-events-none'
        )}
      >
        {/* Left window drag zone */}
        <div data-tauri-drag-region className="drag-area flex flex-1 items-center gap-2">
          <button
            onClick={handleToggleSidebar}
            title={t('notepad.toggleSidebar')}
            className="no-drag flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Menu size={14} />
          </button>

          <span className="flex items-center gap-1 text-xs font-bold tracking-tight text-foreground/90">
            <StickyNote size={14} className="text-amber-500" />
            <span>PastePaw {t('notepad.title')}</span>
          </span>

          {isSaving && (
            <span className="animate-pulse text-[10px] text-muted-foreground">
              {t('notepad.saving')}
            </span>
          )}
        </div>

        {/* Right Top Controls */}
        <div className="no-drag flex items-center gap-1">
          {/* Opacity Control */}
          <div className="relative" ref={opacityRef}>
            <button
              onClick={() => setShowOpacitySlider(!showOpacitySlider)}
              title={t('notepad.opacity')}
              className={clsx(
                'flex h-6 w-6 items-center justify-center rounded transition-colors',
                showOpacitySlider
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground'
              )}
            >
              <Sliders size={13} />
            </button>

            {showOpacitySlider && (
              <div className="animate-in fade-in-0 zoom-in-95 absolute right-0 top-8 z-50 flex w-48 flex-col gap-2.5 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-2xl duration-100">
                <div className="flex items-center justify-between text-xs font-semibold text-popover-foreground">
                  <span>{t('notepad.opacity')}</span>
                  <span className="font-mono font-bold text-amber-500">{opacity}%</span>
                </div>
                <input
                  type="range"
                  min="30"
                  max="100"
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-muted accent-amber-500"
                />
              </div>
            )}
          </div>

          {/* Always on top toggle */}
          <button
            onClick={handleToggleAlwaysOnTop}
            title={isAlwaysOnTop ? t('notepad.alwaysOnTop') : t('notepad.cancelAlwaysOnTop')}
            className={clsx(
              'flex h-6 w-6 items-center justify-center rounded transition-colors',
              isAlwaysOnTop
                ? 'bg-amber-500/20 text-amber-500'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {isAlwaysOnTop ? <Pin size={13} className="fill-amber-500" /> : <PinOff size={13} />}
          </button>

          {/* Minimize */}
          <button
            onClick={handleMinimize}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Minus size={13} />
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
          >
            <X size={13} />
          </button>
        </div>
      </header>

      {/* Main Content Pane */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Left Sidebar (Notes List) */}
        {isSidebarOpen && (
          <aside
            style={{ width: `${sidebarWidth}px` }}
            className={clsx(
              'flex shrink-0 flex-col overflow-hidden border-r border-border/40 bg-background/40 backdrop-blur-md transition-[width] duration-75',
              isResizing && 'select-none transition-none'
            )}
          >
            {/* Sidebar Top Header & Search */}
            <div className="shrink-0 space-y-1.5 border-b border-border/40 p-2">
              {!isMini ? (
                <>
                  <div className="relative">
                    <Search
                      size={12}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      type="text"
                      placeholder={isCompact ? t('notepad.searchCompact') : t('notepad.searchNotes')}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full rounded-md border border-border/50 bg-background/60 py-1 pl-7 pr-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-amber-500/80"
                    />
                  </div>

                  {/* Active / Completed Tabs */}
                  <div className="flex items-center gap-1 rounded-md bg-muted/60 p-0.5 text-[11px]">
                    <button
                      onClick={() => setFilterStatus('active')}
                      className={clsx(
                        'flex flex-1 items-center justify-center gap-1 rounded py-1 font-medium transition-colors',
                        filterStatus === 'active'
                          ? 'bg-background text-amber-500 shadow-xs font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <span>{t('notepad.activeNotes')}</span>
                      <span className="text-[10px] opacity-70">({activeCount})</span>
                    </button>
                    <button
                      onClick={() => setFilterStatus('completed')}
                      className={clsx(
                        'flex flex-1 items-center justify-center gap-1 rounded py-1 font-medium transition-colors',
                        filterStatus === 'completed'
                          ? 'bg-background text-amber-500 shadow-xs font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <span>{t('notepad.completedNotes')}</span>
                      <span className="text-[10px] opacity-70">({completedCount})</span>
                    </button>
                    {filterStatus === 'completed' && completedCount > 0 && (
                      <button
                        onClick={handleClearCompleted}
                        title={t('notepad.clearCompleted')}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>

                  <button
                    onClick={handleCreateNote}
                    title="Ctrl+N"
                    className="active:scale-98 flex w-full items-center justify-center gap-1 rounded-md bg-amber-500/15 py-1 text-xs font-semibold text-amber-500 transition-colors hover:bg-amber-500/25"
                  >
                    <Plus size={13} />
                    <span>{isCompact ? t('notepad.newNoteCompact') : t('notepad.newNote')}</span>
                  </button>
                </>
              ) : (
                /* Mini Mode Top Button & Filters */
                <div className="flex flex-col items-center gap-1.5">
                  <button
                    onClick={handleCreateNote}
                    title={`${t('notepad.newNote')} (Ctrl+N)`}
                    className="flex h-7 w-7 items-center justify-center rounded-md bg-amber-500/20 text-amber-500 transition-colors hover:bg-amber-500/30"
                  >
                    <Plus size={15} />
                  </button>
                  <div className="flex flex-col items-center gap-1">
                    <button
                      onClick={() => setFilterStatus('active')}
                      title={`${t('notepad.activeNotes')} (${activeCount})`}
                      className={clsx(
                        'flex h-6 w-6 items-center justify-center rounded transition-colors',
                        filterStatus === 'active'
                          ? 'bg-amber-500/20 text-amber-500 font-bold'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <CircleDot size={13} />
                    </button>
                    <button
                      onClick={() => setFilterStatus('completed')}
                      title={`${t('notepad.completedNotes')} (${completedCount})`}
                      className={clsx(
                        'flex h-6 w-6 items-center justify-center rounded transition-colors',
                        filterStatus === 'completed'
                          ? 'bg-amber-500/20 text-amber-500 font-bold'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      )}
                    >
                      <CheckCircle2 size={13} />
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Notes List */}
            <div className="no-scrollbar flex-1 space-y-1 overflow-y-auto p-1.5">
              {filteredNotes.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center px-1 text-center">
                  <StickyNote size={20} className="mb-1 text-muted-foreground/40" />
                  {!isMini && (
                    <p className="text-xs text-muted-foreground">
                      {filterStatus === 'completed'
                        ? t('notepad.noCompletedNotes')
                        : filterStatus === 'active' && notes.length > 0
                        ? t('notepad.noActiveNotes')
                        : t('notepad.noNotes')}
                    </p>
                  )}
                </div>
              ) : (
                filteredNotes.map((note) => {
                  const isSelected = selectedNoteId === note.id;
                  const colorObj = NOTE_COLORS.find((c) => c.id === note.color) || NOTE_COLORS[0];
                  const cleanExplicitTitle =
                    note.title && !note.title.startsWith('<') && note.title !== 'Untitled Note'
                      ? note.title.trim()
                      : '';
                  const noteTitle =
                    cleanExplicitTitle ||
                    extractPlainTextPreview(note.content, 40) ||
                    t('notepad.untitled');
                  const noteSnippet = extractPlainTextPreview(note.content) || `(${t('notepad.empty')})`;
                  const taskProgress = getNoteTaskProgress(note.content);

                  if (isMini) {
                    // Mini Icon Mode
                    return (
                      <div
                        key={note.id}
                        onClick={() => selectNote(note)}
                        title={`${noteTitle}\n${noteSnippet}`}
                        className={clsx(
                          'group relative mx-auto flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg border transition-all',
                          isSelected
                            ? 'border-amber-500/60 bg-accent shadow-sm'
                            : 'border-transparent hover:border-border/40 hover:bg-accent/40'
                        )}
                      >
                        <span
                          className={clsx(
                            'h-3.5 w-3.5 rounded-full ring-1 ring-border/50',
                            colorObj.dot,
                            note.is_completed && 'opacity-60'
                          )}
                        />
                        {note.is_pinned ? (
                          <Pin
                            size={8}
                            className="absolute right-0.5 top-0.5 fill-amber-500 text-amber-500"
                          />
                        ) : note.is_completed ? (
                          <CheckCircle2
                            size={9}
                            className="absolute right-0.5 top-0.5 text-emerald-500"
                          />
                        ) : null}
                      </div>
                    );
                  }

                  if (isCompact) {
                    // Compact Mode
                    return (
                      <div
                        key={note.id}
                        onClick={() => selectNote(note)}
                        title={`${noteTitle}\n${noteSnippet}`}
                        className={clsx(
                          'group relative flex cursor-pointer items-center justify-between rounded-lg border p-1.5 text-left transition-all',
                          isSelected
                            ? 'border-amber-500/50 bg-accent/90 shadow-sm'
                            : 'border-transparent hover:border-border/40 hover:bg-accent/40',
                          note.is_completed && 'opacity-70'
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1.5 truncate">
                          <span className={clsx('h-2 w-2 shrink-0 rounded-full', colorObj.dot)} />
                          <span
                            className={clsx(
                              'truncate text-xs font-medium text-foreground/90',
                              note.is_completed && 'line-through text-muted-foreground'
                            )}
                          >
                            {noteTitle}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {taskProgress && (
                            <span className="text-[10px] font-mono text-muted-foreground/70">
                              {taskProgress.checked}/{taskProgress.total}
                            </span>
                          )}
                          {note.is_pinned && (
                            <Pin size={10} className="shrink-0 fill-amber-500 text-amber-500" />
                          )}
                        </div>
                      </div>
                    );
                  }

                  // Standard Mode
                  return (
                    <div
                      key={note.id}
                      onClick={() => selectNote(note)}
                      className={clsx(
                        'group relative flex cursor-pointer flex-col gap-0.5 rounded-lg border p-2 text-left transition-all',
                        isSelected
                          ? 'border-amber-500/50 bg-accent/90 shadow-sm'
                          : 'border-transparent hover:border-border/40 hover:bg-accent/40',
                        note.is_completed && 'opacity-75'
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={clsx('h-2 w-2 shrink-0 rounded-full', colorObj.dot)} />
                          <span
                            className={clsx(
                              'truncate text-xs font-semibold text-foreground/90',
                              note.is_completed && 'line-through text-muted-foreground'
                            )}
                          >
                            {noteTitle}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          {taskProgress && (
                            <span
                              className={clsx(
                                'flex items-center gap-0.5 rounded px-1 text-[10px] font-mono font-medium',
                                taskProgress.checked === taskProgress.total
                                  ? 'bg-emerald-500/15 text-emerald-500'
                                  : 'bg-muted/80 text-muted-foreground'
                              )}
                            >
                              ✓ {taskProgress.checked}/{taskProgress.total}
                            </span>
                          )}
                          {note.is_pinned && (
                            <Pin size={10} className="shrink-0 fill-amber-500 text-amber-500" />
                          )}
                        </div>
                      </div>

                      <p
                        className={clsx(
                          'line-clamp-2 break-all text-[11px] leading-relaxed text-muted-foreground/80',
                          note.is_completed && 'line-through opacity-70'
                        )}
                      >
                        {noteSnippet}
                      </p>

                      <div className="mt-1 flex items-center justify-between text-[10px] text-muted-foreground/50">
                        <span className="flex items-center gap-0.5">
                          <Clock size={10} />
                          {note.updated_at ? note.updated_at.slice(5, 16).replace('T', ' ') : ''}
                        </span>

                        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleToggleComplete(note.id);
                            }}
                            title={
                              note.is_completed
                                ? t('notepad.markAsActive')
                                : t('notepad.markAsCompleted')
                            }
                            className={clsx(
                              'p-0.5 transition-colors',
                              note.is_completed
                                ? 'text-emerald-500 hover:text-emerald-600'
                                : 'hover:text-emerald-500'
                            )}
                          >
                            <CheckCircle2 size={11} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleTogglePin(note.id);
                            }}
                            title={note.is_pinned ? t('notepad.unpinned') : t('notepad.pinned')}
                            className="p-0.5 hover:text-amber-500"
                          >
                            <Pin size={11} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteNote(note.id);
                            }}
                            title={t('notepad.deleteNote')}
                            className="p-0.5 hover:text-red-400"
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </aside>
        )}

        {/* Resizable Divider Drag Handle */}
        {isSidebarOpen && (
          <div
            onMouseDown={startResizing}
            className={clsx(
              'group relative flex w-1.5 shrink-0 cursor-col-resize select-none items-center justify-center transition-colors',
              isResizing ? 'bg-amber-500/50' : 'hover:bg-amber-500/30'
            )}
            title={t('notepad.resizeSidebarTip')}
          >
            <div
              className={clsx(
                'h-full w-[1px] transition-colors',
                isResizing ? 'bg-amber-500' : 'bg-border/60 group-hover:bg-amber-500/70'
              )}
            />
          </div>
        )}

        {/* Right / Main Note Editor */}
        <main
          className={clsx(
            'flex flex-1 flex-col overflow-hidden transition-colors',
            currentColorObj.bg
          )}
        >
          {/* Note Top Toolbar */}
          <div
            className={clsx(
              'flex shrink-0 items-center justify-between bg-background/30 backdrop-blur-sm transition-all duration-200 ease-in-out',
              showChrome
                ? 'h-9 border-b border-border/40 px-3 opacity-100'
                : 'h-0 border-b-0 px-3 py-0 opacity-0 overflow-hidden pointer-events-none'
            )}
          >
            {/* Title Input & Status Badge */}
            <div className="mr-2 flex min-w-0 flex-1 items-center gap-1.5">
              <input
                type="text"
                placeholder={t('notepad.titlePlaceholder')}
                value={title}
                onChange={handleTitleChange}
                className={clsx(
                  'min-w-0 flex-1 truncate bg-transparent text-sm font-semibold text-foreground outline-none placeholder:text-muted-foreground/40',
                  isCompleted && 'line-through text-muted-foreground/70'
                )}
              />
              {isCompleted && (
                <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                  {t('notepad.completed')}
                </span>
              )}
            </div>

            {/* Quick Markdown Format Buttons */}
            {editor && (
              <div className="mr-2 hidden items-center gap-0.5 sm:flex">
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  title={`${t('notepad.bold')} (Ctrl+B)`}
                  className={clsx(
                    'rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    editor.isActive('bold') && 'bg-amber-500/20 font-bold text-amber-500'
                  )}
                >
                  <BoldIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                  title={`${t('notepad.strike')} (~~文字~~)`}
                  className={clsx(
                    'rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    editor.isActive('strike') && 'bg-amber-500/20 text-amber-500'
                  )}
                >
                  <StrikeIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleTaskList().run()}
                  title={`${t('notepad.taskList')} ([] + 空格)`}
                  className={clsx(
                    'rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    editor.isActive('taskList') && 'bg-amber-500/20 text-amber-500'
                  )}
                >
                  <TaskIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                  title={`${t('notepad.bulletList')} (- + 空格)`}
                  className={clsx(
                    'rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    editor.isActive('bulletList') && 'bg-amber-500/20 text-amber-500'
                  )}
                >
                  <ListIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleOrderedList().run()}
                  title={`${t('notepad.orderedList')} (1. + 空格)`}
                  className={clsx(
                    'rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    editor.isActive('orderedList') && 'bg-amber-500/20 text-amber-500'
                  )}
                >
                  <OrderedListIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleCode().run()}
                  title={`${t('notepad.code')} (\`代码\`)}`}
                  className={clsx(
                    'rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground',
                    editor.isActive('code') && 'bg-amber-500/20 text-amber-500'
                  )}
                >
                  <CodeIcon size={12} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().setHorizontalRule().run()}
                  title={`${t('notepad.divider')} (--- 回车)`}
                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
                >
                  <DividerIcon size={12} />
                </button>
              </div>
            )}

            {/* Color Tag Picker & Top Actions */}
            <div className="flex shrink-0 items-center gap-1.5">
              {NOTE_COLORS.map((c) => (
                <button
                  key={c.id}
                  onClick={() => handleColorChange(c.id)}
                  title={c.name}
                  className={clsx(
                    'h-4 w-4 shrink-0 rounded-full transition-transform hover:scale-110',
                    c.dot,
                    color === c.id && 'scale-110 ring-2 ring-amber-500 ring-offset-1'
                  )}
                />
              ))}

              <div className="mx-1 h-3.5 w-[1px] shrink-0 bg-border/40" />

              {/* Complete / Restore Note */}
              <button
                onClick={() => selectedNoteId && handleToggleComplete(selectedNoteId)}
                title={
                  isCompleted
                    ? t('notepad.markAsActive')
                    : `${t('notepad.markAsCompleted')} (Ctrl+D)`
                }
                className={clsx(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
                  isCompleted
                    ? 'bg-emerald-500/20 text-emerald-500'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                )}
              >
                <CheckCircle2 size={13} className={isCompleted ? 'stroke-[2.5]' : ''} />
              </button>

              {/* Pin Note */}
              <button
                onClick={() => selectedNoteId && handleTogglePin(selectedNoteId)}
                title={isPinned ? t('notepad.unpinned') : t('notepad.pinned')}
                className={clsx(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
                  isPinned
                    ? 'bg-amber-500/20 text-amber-500'
                    : 'text-muted-foreground hover:bg-accent'
                )}
              >
                <Pin size={12} className={isPinned ? 'fill-amber-500' : ''} />
              </button>

              {/* Delete Note */}
              <button
                onClick={() => selectedNoteId && handleDeleteNote(selectedNoteId)}
                title={t('notepad.deleteNote')}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-red-500/20 hover:text-red-400"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>

          {/* Tiptap Rich Markdown Editor */}
          <div className="relative flex-1 overflow-y-auto p-3 text-xs leading-relaxed">
            {editor && (
              <BubbleMenu
                editor={editor}
                className="flex items-center gap-1 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl"
              >
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBold().run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('bold') && 'bg-amber-500/20 font-bold text-amber-500'
                  )}
                  title={t('notepad.bold')}
                >
                  <BoldIcon size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleStrike().run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('strike') && 'bg-amber-500/20 text-amber-500'
                  )}
                  title={t('notepad.strike')}
                >
                  <StrikeIcon size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('heading', { level: 1 }) && 'bg-amber-500/20 text-amber-500'
                  )}
                  title={t('notepad.heading1')}
                >
                  <Heading1 size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('heading', { level: 2 }) && 'bg-amber-500/20 text-amber-500'
                  )}
                  title={t('notepad.heading2')}
                >
                  <Heading2 size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleTaskList().run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('taskList') && 'bg-amber-500/20 text-amber-500'
                  )}
                  title={t('notepad.taskList')}
                >
                  <TaskIcon size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleBulletList().run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('bulletList') && 'bg-amber-500/20 text-amber-500'
                  )}
                  title={t('notepad.bulletList')}
                >
                  <ListIcon size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => editor.chain().focus().toggleCode().run()}
                  className={clsx(
                    'rounded p-1.5 transition-colors hover:bg-accent',
                    editor.isActive('code') && 'bg-amber-500/20 text-amber-500'
                  )}
                  title={t('notepad.code')}
                >
                  <CodeIcon size={13} />
                </button>
              </BubbleMenu>
            )}

            <EditorContent editor={editor} className="h-full min-h-[140px] focus:outline-none" />
          </div>

          {/* Footer Status Bar & Action Buttons - Single line guaranteed */}
          <footer
            className={clsx(
              'flex shrink-0 select-none items-center justify-between bg-background/40 text-[11px] text-muted-foreground backdrop-blur-sm transition-all duration-200 ease-in-out',
              showChrome
                ? 'h-8 border-t border-border/40 px-3 opacity-100'
                : 'h-0 border-t-0 px-3 py-0 opacity-0 overflow-hidden pointer-events-none'
            )}
          >
            <div className="flex min-w-0 items-center gap-1.5 truncate text-[11px]">
              <span className="truncate">
                {t('notepad.charCount', { chars: charCount, words: wordCount })}
              </span>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
              {/* Copy All */}
              <button
                onClick={handleCopyAll}
                title={`Ctrl+Shift+C / ${t('notepad.copyAll')}`}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent"
              >
                <Copy size={12} className="shrink-0" />
                <span>{t('notepad.copyAll')}</span>
              </button>

              {/* Paste to App */}
              <button
                onClick={handlePasteToApp}
                title={t('notepad.pasteToAppTip')}
                className="flex shrink-0 items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 text-xs font-semibold text-black shadow-sm transition-all hover:bg-amber-400 active:scale-95"
              >
                <CornerDownLeft size={12} className="shrink-0" />
                <span>{t('notepad.pasteToApp')}</span>
              </button>
            </div>
          </footer>
        </main>
      </div>

      <Toaster richColors position="bottom-center" theme={effectiveTheme} />
    </div>
  );
}
