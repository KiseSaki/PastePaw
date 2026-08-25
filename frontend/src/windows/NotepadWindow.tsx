import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { NoteItem, NOTE_COLORS, Settings } from '../types';
import { useTheme } from '../hooks/useTheme';
import { useLanguage } from '../hooks/useLanguage';
import { useTranslation } from 'react-i18next';
import { Toaster, toast } from 'sonner';
import {
  Pin,
  PinOff,
  Plus,
  Search,
  Sliders,
  Minus,
  X,
  Copy,
  CornerDownLeft,
  Trash2,
  Menu,
  StickyNote,
  Clock,
} from 'lucide-react';
import { clsx } from 'clsx';

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

  // Editor states
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [color, setColor] = useState('default');
  const [isPinned, setIsPinned] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const activeNoteRef = useRef<NoteItem | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const opacityRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  }, [loadNotes, searchQuery]);

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
  }, [loadNotes, searchQuery]);

  // Select note
  const selectNote = (note: NoteItem) => {
    activeNoteRef.current = note;
    setSelectedNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    setColor(note.color || 'default');
    setIsPinned(note.is_pinned);
  };

  // Debounced auto-save
  const triggerAutoSave = useCallback((newTitle: string, newContent: string, newColor: string) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    setIsSaving(true);
    saveTimeoutRef.current = setTimeout(async () => {
      const currentId = activeNoteRef.current?.id;
      if (!currentId) {
        setIsSaving(false);
        return;
      }

      try {
        const updated = await invoke<NoteItem>('update_note', {
          id: currentId,
          title: newTitle.trim() || null,
          content: newContent,
          color: newColor,
        });
        activeNoteRef.current = updated;
        setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      } catch (err) {
        console.error('Failed to auto-save note:', err);
      } finally {
        setIsSaving(false);
      }
    }, 300);
  }, []);

  // Content change
  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    triggerAutoSave(title, newContent, color);
  };

  // Title change
  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    triggerAutoSave(newTitle, content, color);
  };

  // Color change
  const handleColorChange = (newColor: string) => {
    setColor(newColor);
    triggerAutoSave(title, content, newColor);
  };

  // Create new note
  const handleCreateNote = async () => {
    try {
      const newNote = await invoke<NoteItem>('create_note', {
        title: null,
        content: '',
        color: 'default',
      });
      setNotes((prev) => [newNote, ...prev]);
      selectNote(newNote);
      textareaRef.current?.focus();
    } catch (err) {
      console.error('Failed to create note:', err);
      toast.error(t('notepad.createFailed'));
    }
  };

  // Delete note
  const handleDeleteNote = async (id: string) => {
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

  // Copy full note
  const handleCopyAll = async () => {
    if (!content) {
      toast.info(t('notepad.emptyNote'));
      return;
    }
    try {
      await navigator.clipboard.writeText(content);
      toast.success(t('notepad.copiedToClipboard'));
    } catch (err) {
      console.error('Failed to copy note:', err);
    }
  };

  // Paste to application
  const handlePasteToApp = async () => {
    if (!content) {
      toast.info(t('notepad.emptyNote'));
      return;
    }
    try {
      await invoke('paste_note', { content });
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

  // Resizable Divider Drag Handler
  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startW = sidebarWidthRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const maxAllowed = Math.min(420, Math.floor(window.innerWidth * 0.65));
      let newW = startW + delta;

      if (newW < 48) {
        setIsSidebarOpen(false);
      } else {
        setIsSidebarOpen(true);
        newW = Math.max(48, Math.min(newW, maxAllowed));
        setSidebarWidth(newW);
        localStorage.setItem('pastepaw_notepad_sidebar_width', String(newW));
      }
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, []);

  // Keyboard Shortcuts inside window
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+N: New Note
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handleCreateNote();
        return;
      }

      // Ctrl+Enter: Paste to App
      if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        handlePasteToApp();
        return;
      }

      // Ctrl+Shift+C: Copy All
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        handleCopyAll();
        return;
      }

      // Escape: Close
      if (e.key === 'Escape' && !showOpacitySlider) {
        handleClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [content, selectedNoteId, showOpacitySlider]);

  // Click outside opacity dropdown
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (opacityRef.current && !opacityRef.current.contains(e.target as Node)) {
        setShowOpacitySlider(false);
      }
    };
    if (showOpacitySlider) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showOpacitySlider]);

  // Calculate word & char count
  const charCount = content.length;
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  const currentColorObj = NOTE_COLORS.find((c) => c.id === color) || NOTE_COLORS[0];

  // Sidebar responsive modes
  const isStandard = sidebarWidth >= 165;
  const isCompact = sidebarWidth >= 100 && sidebarWidth < 165;
  const isMini = sidebarWidth < 100;

  return (
    <div
      className={clsx(
        'relative flex h-screen w-screen select-none flex-col overflow-hidden rounded-lg border border-border/70 text-foreground shadow-2xl transition-opacity duration-150',
        effectiveTheme === 'dark'
          ? 'bg-neutral-900/95 backdrop-blur-xl'
          : 'bg-white/95 backdrop-blur-xl'
      )}
      style={{ opacity: opacity / 100 }}
    >
      {/* Custom Title Bar / Header - Layered with z-30 to prevent popover being covered */}
      <header
        data-tauri-drag-region
        className="relative z-30 flex h-11 shrink-0 cursor-move items-center justify-between border-b border-border/50 bg-muted/40 px-3 backdrop-blur-md"
      >
        <div className="pointer-events-none flex items-center gap-2">
          <StickyNote size={17} className="text-amber-500" />
          <span className="text-xs font-semibold tracking-wide text-foreground/90">
            {t('notepad.title')}
          </span>
          {isSaving && (
            <span className="ml-1 animate-pulse text-[10px] text-muted-foreground">Saving...</span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-1">
          {/* Toggle Sidebar */}
          <button
            onClick={handleToggleSidebar}
            title={t('notepad.sidebar')}
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
              isSidebarOpen && 'bg-accent/60 text-foreground'
            )}
          >
            <Menu size={14} />
          </button>

          {/* Opacity Menu */}
          <div className="relative" ref={opacityRef}>
            <button
              onClick={() => setShowOpacitySlider(!showOpacitySlider)}
              title={t('notepad.opacity')}
              className={clsx(
                'flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
                showOpacitySlider && 'bg-accent/60 text-foreground'
              )}
            >
              <Sliders size={14} />
            </button>

            {showOpacitySlider && (
              <div className="animate-in fade-in-0 zoom-in-95 bg-card/98 dark:bg-neutral-900/98 absolute right-0 top-9 z-50 flex w-44 flex-col gap-2 rounded-xl border border-border/80 p-3 shadow-2xl backdrop-blur-2xl">
                <div className="flex justify-between text-xs font-medium">
                  <span className="text-muted-foreground">{t('notepad.opacity')}</span>
                  <span className="font-mono">{opacity}%</span>
                </div>
                <input
                  type="range"
                  min="40"
                  max="100"
                  step="2"
                  value={opacity}
                  onChange={(e) => setOpacity(Number(e.target.value))}
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-secondary accent-amber-500"
                />
              </div>
            )}
          </div>

          {/* Pin Always on Top Toggle */}
          <button
            onClick={handleToggleAlwaysOnTop}
            title={isAlwaysOnTop ? t('notepad.cancelAlwaysOnTop') : t('notepad.alwaysOnTop')}
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-lg transition-colors',
              isAlwaysOnTop
                ? 'bg-amber-500/20 text-amber-500 hover:bg-amber-500/30'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {isAlwaysOnTop ? <Pin size={14} className="fill-amber-500" /> : <PinOff size={14} />}
          </button>

          <div className="mx-1 h-3.5 w-[1px] bg-border/60" />

          {/* Minimize */}
          <button
            onClick={handleMinimize}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Minus size={14} />
          </button>

          {/* Close */}
          <button
            onClick={handleClose}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-red-500/20 hover:text-red-500"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Collapsible & Draggable Left Sidebar */}
        {isSidebarOpen && (
          <aside
            style={{ width: `${sidebarWidth}px` }}
            className="flex shrink-0 flex-col border-r border-border/50 bg-muted/20"
          >
            {/* Search & New Note Header */}
            <div className="flex flex-col gap-1.5 border-b border-border/40 p-2">
              {!isMini ? (
                <>
                  <div className="relative flex items-center">
                    <Search size={13} className="absolute left-2 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder={isStandard ? t('notepad.searchPlaceholder') : '搜索...'}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="h-7 w-full rounded-lg border border-border/50 bg-background/80 pl-7 pr-2 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-amber-500/60"
                    />
                  </div>

                  <button
                    onClick={handleCreateNote}
                    title={t('notepad.newNote')}
                    className="flex h-7 items-center justify-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/15 text-xs font-medium text-amber-600 transition-all hover:bg-amber-500/25 active:scale-[0.98] dark:text-amber-400"
                  >
                    <Plus size={14} />
                    <span>{isStandard ? t('notepad.newNote') : '新建'}</span>
                  </button>
                </>
              ) : (
                <div className="flex flex-col items-center gap-1">
                  <button
                    onClick={handleCreateNote}
                    title={t('notepad.newNote')}
                    className="flex h-7 w-7 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/15 text-amber-600 transition-all hover:bg-amber-500/25 active:scale-95 dark:text-amber-400"
                  >
                    <Plus size={15} />
                  </button>
                </div>
              )}
            </div>

            {/* Notes List */}
            <div className="no-scrollbar flex-1 space-y-1 overflow-y-auto p-1.5">
              {notes.length === 0 ? (
                <div className="flex h-32 flex-col items-center justify-center px-1 text-center">
                  <StickyNote size={20} className="mb-1 text-muted-foreground/40" />
                  {!isMini && (
                    <p className="text-xs text-muted-foreground">{t('notepad.noNotes')}</p>
                  )}
                </div>
              ) : (
                notes.map((note) => {
                  const isSelected = selectedNoteId === note.id;
                  const colorObj = NOTE_COLORS.find((c) => c.id === note.color) || NOTE_COLORS[0];
                  const noteTitle = note.title || 'Untitled Note';

                  if (isMini) {
                    // Mini Icon Mode
                    return (
                      <div
                        key={note.id}
                        onClick={() => selectNote(note)}
                        title={`${noteTitle}\n${note.content || '(Empty)'}`}
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
                            colorObj.dot
                          )}
                        />
                        {note.is_pinned && (
                          <Pin
                            size={8}
                            className="absolute right-0.5 top-0.5 fill-amber-500 text-amber-500"
                          />
                        )}
                      </div>
                    );
                  }

                  if (isCompact) {
                    // Compact Mode
                    return (
                      <div
                        key={note.id}
                        onClick={() => selectNote(note)}
                        title={`${noteTitle}\n${note.content || '(Empty)'}`}
                        className={clsx(
                          'group relative flex cursor-pointer items-center justify-between rounded-lg border p-1.5 text-left transition-all',
                          isSelected
                            ? 'border-amber-500/50 bg-accent/90 shadow-sm'
                            : 'border-transparent hover:border-border/40 hover:bg-accent/40'
                        )}
                      >
                        <div className="flex min-w-0 items-center gap-1.5 truncate">
                          <span className={clsx('h-2 w-2 shrink-0 rounded-full', colorObj.dot)} />
                          <span className="truncate text-xs font-medium text-foreground/90">
                            {noteTitle}
                          </span>
                        </div>
                        {note.is_pinned && (
                          <Pin size={10} className="shrink-0 fill-amber-500 text-amber-500" />
                        )}
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
                          : 'border-transparent hover:border-border/40 hover:bg-accent/40'
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span className={clsx('h-2 w-2 shrink-0 rounded-full', colorObj.dot)} />
                          <span className="truncate text-xs font-semibold text-foreground/90">
                            {noteTitle}
                          </span>
                        </div>
                        {note.is_pinned && (
                          <Pin size={10} className="shrink-0 fill-amber-500 text-amber-500" />
                        )}
                      </div>

                      <p className="line-clamp-2 break-all text-[11px] leading-relaxed text-muted-foreground/80">
                        {note.content || '(Empty)'}
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
            title="按住拖拽调整侧边栏宽度"
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
          <div className="flex shrink-0 items-center justify-between border-b border-border/40 bg-background/30 px-3 py-1.5 backdrop-blur-sm">
            {/* Title Input */}
            <input
              type="text"
              placeholder={t('notepad.titlePlaceholder')}
              value={title}
              onChange={handleTitleChange}
              className="mr-2 min-w-0 flex-1 truncate bg-transparent text-sm font-semibold text-foreground outline-none placeholder:text-muted-foreground/40"
            />

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

          {/* Textarea Editor */}
          <div className="relative flex-1 p-3">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={handleContentChange}
              placeholder={t('notepad.contentPlaceholder')}
              className="no-scrollbar h-full w-full select-text resize-none bg-transparent font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/40"
              autoFocus
            />
          </div>

          {/* Footer Status Bar & Action Buttons - Single line guaranteed */}
          <footer className="flex h-8 shrink-0 select-none items-center justify-between border-t border-border/40 bg-background/40 px-3 text-[11px] text-muted-foreground backdrop-blur-sm">
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
