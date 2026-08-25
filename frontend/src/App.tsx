import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { openUrl } from '@tauri-apps/plugin-opener';
import { ClipboardItem as AppClipboardItem, FolderItem, Settings, SortMode } from './types';
import { ClipList } from './components/ClipList';
import { ControlBar } from './components/ControlBar';
import { DragPreview } from './components/DragPreview';
import { ContextMenu } from './components/ContextMenu';
import { FolderModal } from './components/FolderModal';
import { useKeyboard } from './hooks/useKeyboard';
import { useTheme } from './hooks/useTheme';
import { useLanguage } from './hooks/useLanguage';
import { useTranslation } from 'react-i18next';
import { Toaster, toast } from 'sonner';
import { LAYOUT } from './constants';
import { generateDemoClips } from './debug/demoData';

const base64ToBlob = (base64: string, mimeType: string = 'image/png'): Blob => {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
};

const getImageMimeType = (metadata: string | null): string => {
  if (!metadata) return 'image/png';
  try {
    const parsed = JSON.parse(metadata) as { format?: string };
    const format = parsed.format?.toLowerCase();
    if (format === 'jpeg' || format === 'jpg') return 'image/jpeg';
    if (format === 'webp') return 'image/webp';
  } catch {
    // Ignore metadata parse errors and fall back.
  }
  return 'image/png';
};

function App() {
  const [clips, setClips] = useState<AppClipboardItem[]>([]);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>('time_desc');
  const [clipListResetToken, setClipListResetToken] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [theme, setTheme] = useState('system');
  const [settings, setSettings] = useState<Settings | null>(null);

  // Simulated Drag State
  const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState({ x: 0, y: 0 });
  const [dragTargetFolderId, setDragTargetFolderId] = useState<string | null>(null);

  // Add Folder Modal State
  const [showAddFolderModal, setShowAddFolderModal] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  // Using refs for event handlers to access latest state without re-attaching listeners
  const dragStateRef = useRef({
    isDragging: false,
    clipId: null as string | null,
    targetFolderId: null as string | null,
    pendingDrag: null as { clipId: string; startX: number; startY: number } | null,
  });

  const effectiveTheme = useTheme(theme);
  useLanguage(settings?.language);
  const { t } = useTranslation();

  const selectedFolderRef = useRef(selectedFolder);
  selectedFolderRef.current = selectedFolder;
  const loadPerfIdRef = useRef(0);
  const perfLogEnabled =
    typeof window !== 'undefined' &&
    (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');

  useEffect(() => {
    invoke<Settings>('get_settings')
      .then((s) => {
        setTheme(s.theme);
        setSettings(s);
      })
      .catch(console.error);

    // Listen for setting changes from the settings window
    const unlisten = listen<Settings>('settings-changed', (event) => {
      setTheme(event.payload.theme);
      setSettings(event.payload);
    });

    // Debug only: load demo clips / restore actual data when triggered from settings
    const unlistenDemo = import.meta.env.DEV
      ? Promise.all([
          listen('load-demo-data', () => {
            setClips(generateDemoClips());
            setHasMore(false);
          }),
          listen('restore-actual-data', () => {
            loadClips(selectedFolderRef.current, false, '');
          }),
        ])
      : Promise.resolve([() => {}, () => {}]);

    return () => {
      unlisten.then((f) => f());
      unlistenDemo.then((fs) => fs.forEach((f) => f()));
    };
  }, []);

  const openSettings = useCallback(async () => {
    // Check if settings window already exists
    const existingWin = await WebviewWindow.getByLabel('settings');
    if (existingWin) {
      try {
        await invoke('focus_window', { label: 'settings' });
      } catch (e) {
        console.error('Failed to focus settings window:', e);
        // Fallback to JS API if command fails (though command is preferred)
        await existingWin.unminimize();
        await existingWin.show();
        await existingWin.setFocus();
      }
      invoke('hide_window').catch(console.error);
      return;
    }

    const settingsWin = new WebviewWindow('settings', {
      url: 'index.html?window=settings',
      title: 'Settings',
      width: 800,
      height: 700,
      resizable: true,
      decorations: false, // We have our own title bar in SettingsPanel
      transparent: false,
      center: true,
    });

    settingsWin.once('tauri://created', function () {
      invoke('hide_window').catch(console.error);
    });

    settingsWin.once('tauri://error', function (e) {
      console.error('Error creating settings window', e);
    });
  }, []);

  const openNotepad = useCallback(async (noteId?: string) => {
    try {
      await invoke('open_notepad_window', { noteId: noteId || null });
    } catch (e) {
      console.error('Failed to open notepad window:', e);
    }
  }, []);

  const loadClips = useCallback(
    async (folderId: string | null, append: boolean = false, searchQuery: string = '') => {
      const perfId = ++loadPerfIdRef.current;
      const loadStart = perfLogEnabled ? performance.now() : 0;
      let invokeStart = 0;
      let invokeEnd = 0;

      try {
        setIsLoading(true);

        const currentOffset = append ? clips.length : 0;

        let data: AppClipboardItem[];

        if (searchQuery.trim()) {
          if (perfLogEnabled) invokeStart = performance.now();
          data = await invoke<AppClipboardItem[]>('search_clips', {
            query: searchQuery,
            filterId: folderId,
            limit: 20,
            offset: currentOffset,
          });
          if (perfLogEnabled) invokeEnd = performance.now();
        } else {
          if (perfLogEnabled) invokeStart = performance.now();
          data = await invoke<AppClipboardItem[]>('get_clips', {
            filterId: folderId,
            limit: 20,
            offset: currentOffset,
            previewOnly: true,
          });
          if (perfLogEnabled) invokeEnd = performance.now();
        }

        const imageCount = perfLogEnabled
          ? data.filter((item) => item.clip_type === 'image').length
          : 0;
        const totalContentChars = perfLogEnabled
          ? data.reduce((sum, item) => sum + (item.content?.length ?? 0), 0)
          : 0;
        const imageContentChars = perfLogEnabled
          ? data
              .filter((item) => item.clip_type === 'image')
              .reduce((sum, item) => sum + (item.content?.length ?? 0), 0)
          : 0;

        if (append) {
          setClips((prev) => {
            return [...prev, ...data];
          });
        } else {
          setClips(data);
        }

        // If we got fewer than limit, no more clips
        setHasMore(data.length === 20);

        if (perfLogEnabled) {
          const stateQueuedAt = performance.now();
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const paintedAt = performance.now();
              console.info('[perf][loadClips]', {
                id: perfId,
                folderId: folderId ?? 'all',
                append,
                hasSearch: Boolean(searchQuery.trim()),
                offset: currentOffset,
                itemCount: data.length,
                imageCount,
                totalContentChars,
                imageContentChars,
                invokeMs: Number((invokeEnd - invokeStart).toFixed(1)),
                queueToPaintMs: Number((paintedAt - stateQueuedAt).toFixed(1)),
                totalMs: Number((paintedAt - loadStart).toFixed(1)),
              });
            });
          });
        }
      } catch (error) {
        console.error('Failed to load clips:', error);
      } finally {
        setIsLoading(false);
      }
    },
    [clips.length]
  );

  const loadFolders = useCallback(async () => {
    try {
      const data = await invoke<FolderItem[]>('get_folders');

      setFolders(data);
    } catch (error) {
      console.error('Failed to load folders:', error);
    }
  }, []);

  const refreshCurrentFolder = useCallback(() => {
    loadClips(selectedFolderRef.current, false, searchQuery);
  }, [loadClips, searchQuery]);

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
  }, []);

  const handleSelectFolder = useCallback((folderId: string | null) => {
    // Reset view-level selection state whenever user switches/re-clicks folders.
    setSelectedClipId(null);
    setClipListResetToken((prev) => prev + 1);
    setSelectedFolder(folderId);
  }, []);

  useEffect(() => {
    loadFolders();
    if (searchQuery.trim()) {
      loadClips(selectedFolder, false, searchQuery);
    } else {
      loadClips(selectedFolder);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFolder, searchQuery]);

  // Handle global mouse events for simulated drag
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      const state = dragStateRef.current;

      // If we are already dragging, update position
      if (state.isDragging) {
        setDragPosition({ x: e.clientX, y: e.clientY });
        return;
      }

      // If we have a pending drag, check threshold
      if (state.pendingDrag) {
        const dx = e.clientX - state.pendingDrag.startX;
        const dy = e.clientY - state.pendingDrag.startY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist > 5) {
          // Start actual drag
          setDraggingClipId(state.pendingDrag.clipId);
          setDragPosition({ x: e.clientX, y: e.clientY });
          dragStateRef.current.isDragging = true;
          dragStateRef.current.clipId = state.pendingDrag.clipId;
          dragStateRef.current.pendingDrag = null;
        }
      }
    };

    const handleGlobalMouseUp = (_: MouseEvent) => {
      // Always clear pending drag on mouse up
      if (dragStateRef.current.pendingDrag) {
        dragStateRef.current.pendingDrag = null;
      }

      if (dragStateRef.current.isDragging) {
        finishDrag();
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, []);

  const startDrag = (clipId: string, startX: number, startY: number) => {
    // Instead of starting immediately, set pending
    dragStateRef.current.pendingDrag = { clipId, startX, startY };
    dragStateRef.current.clipId = clipId;
    // We don't set state yet, avoiding re-render until threshold passed
  };

  const finishDrag = () => {
    if (dragStateRef.current.targetFolderId !== undefined && dragStateRef.current.clipId) {
      // We only move if targetFolderId was explicitly set by a hover event.
      // Wait, how do we distinguish "Not Hovering" vs "Hovering 'All' (null)"?
      // We will make ControlBar pass a specific sentinel for "No Target" when leaving?
      // Or simply: ControlBar tracks hover. If hover, it calls setDragTargetFolderId.
      // If we drop and dragTargetFolderId is valid, we move.
      // BUT 'null' is a valid folder ID (All).
      // Let's use a generic 'undefined' for "No Target".
    }

    // Actually, simpler:
    // When MouseUp happens, we check dragTargetFolderId state.
    // If it is NOT undefined, we execute move.

    // IMPORTANT: State updates in React are async. accessing `dragTargetFolderId` state inside event listener might be stale?
    // That's why we use `dragStateRef`.

    const { clipId, targetFolderId } = dragStateRef.current;
    if (clipId && targetFolderId !== undefined && targetFolderId !== 'NO_TARGET') {
      handleMoveClip(clipId, targetFolderId);
    }

    setDraggingClipId(null);
    setDragTargetFolderId(null);
    dragStateRef.current = {
      isDragging: false,
      clipId: null,
      targetFolderId: 'NO_TARGET',
      pendingDrag: null,
    };
  };

  const handleDragHover = (folderId: string | null) => {
    setDragTargetFolderId(folderId);
    dragStateRef.current.targetFolderId = folderId;
  };

  const handleDragLeave = () => {
    setDragTargetFolderId(null);
    dragStateRef.current.targetFolderId = 'NO_TARGET';
  };

  // Total History Count
  const [totalClipCount, setTotalClipCount] = useState(0);

  const refreshTotalCount = useCallback(async () => {
    try {
      const count = await invoke<number>('get_clipboard_history_size');
      setTotalClipCount(count);
    } catch (e) {
      console.error('Failed to get history size', e);
    }
  }, []);

  useEffect(() => {
    refreshTotalCount();
  }, [refreshTotalCount]);

  useEffect(() => {
    const unlistenClipboard = listen('clipboard-change', () => {
      refreshCurrentFolder();
      loadFolders(); // Refresh folders to get updated counts
      refreshTotalCount(); // Refresh total count
    });

    return () => {
      unlistenClipboard.then((unlisten) => {
        if (typeof unlisten === 'function') unlisten();
      });
    };
  }, [refreshCurrentFolder, loadFolders, refreshTotalCount]);

  useEffect(() => {
    const unlistenShow = listen('window-show', () => {
      setSelectedClipId(null);
      setSearchQuery('');
      setShowSearch(false);
      setClipListResetToken((prev) => prev + 1);
      loadClips(selectedFolderRef.current, false, '');
      loadFolders();
      refreshTotalCount();
    });

    return () => {
      unlistenShow.then((unlisten) => {
        if (typeof unlisten === 'function') unlisten();
      });
    };
  }, [loadClips, loadFolders, refreshTotalCount]);

  const handleDelete = async (clipId: string | null) => {
    const targetId = clipId || (clips.length > 0 ? clips[0].id : null);
    if (!targetId) return;
    try {
      await invoke('delete_clip', { id: targetId, hardDelete: false });
      setClips(clips.filter((c) => c.id !== targetId));
      setSelectedClipId(null);
      // Refresh counts
      loadFolders();
      refreshTotalCount();
      toast.success(t('notifications.clipDeleted'));
    } catch (error) {
      console.error('Failed to delete clip:', error);
      toast.error(t('notifications.clipDeleteFailed'));
    }
  };

  const getFullImageBlob = useCallback(
    async (clipId: string, fallbackClip: AppClipboardItem): Promise<Blob> => {
      const detail = await invoke<AppClipboardItem>('get_clip_detail', { id: clipId });
      const mimeType = getImageMimeType(detail.metadata ?? fallbackClip.metadata);
      return base64ToBlob(detail.content, mimeType);
    },
    []
  );

  const sortedClips = useMemo(() => {
    return [...clips].sort((a, b) => {
      // Pinned clips always stay at the very top
      const pinA = a.is_pinned ? 1 : 0;
      const pinB = b.is_pinned ? 1 : 0;
      if (pinA !== pinB) {
        return pinB - pinA;
      }

      switch (sortMode) {
        case 'time_asc':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'app':
          return (a.source_app || '').localeCompare(b.source_app || '');
        case 'type':
          return a.clip_type.localeCompare(b.clip_type);
        case 'length':
          return (b.content?.length || 0) - (a.content?.length || 0);
        case 'time_desc':
        default:
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }
    });
  }, [clips, sortMode]);

  const handlePaste = async (clipId: string) => {
    try {
      const clip = clips.find((c) => c.id === clipId);
      if (clip && clip.clip_type === 'image') {
        try {
          const blob = await getFullImageBlob(clipId, clip);
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        } catch (e) {
          console.error('Frontend clipboard write failed', e);
        }
      }

      invoke('paste_clip', { id: clipId }).catch(console.error);
    } catch (error) {
      console.error('Failed to paste clip:', error);
    }
  };

  const handlePastePlainText = async (clipId: string) => {
    try {
      await invoke('paste_plain_text', { id: clipId });
    } catch (e) {
      console.error('Failed to paste plain text:', e);
    }
  };

  const handleCopy = async (clipId: string) => {
    try {
      const clip = clips.find((c) => c.id === clipId);
      if (clip && clip.clip_type === 'image') {
        const blob = await getFullImageBlob(clipId, clip);
        await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      }

      await invoke('paste_clip', { id: clipId });

      toast.success(t('common.copied'));
    } catch (error) {
      console.error('Failed to copy clip:', error);
      toast.error(t('notifications.copyFailed'));
    }
  };

  const handleCopyPlainText = async (clip: AppClipboardItem) => {
    try {
      let text = clip.content;
      if (clip.clip_type === 'image') {
        text = clip.preview;
      }
      await navigator.clipboard.writeText(text.trim());
      toast.success(t('common.copied'));
    } catch (error) {
      console.error('Failed to copy plain text:', error);
    }
  };

  const handleTogglePin = async (clipId: string) => {
    try {
      const isPinned = await invoke<boolean>('toggle_pin_clip', { id: clipId });
      setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, is_pinned: isPinned } : c)));
      toast.success(isPinned ? t('contextMenu.pin') : t('contextMenu.unpin'));
    } catch (e) {
      console.error('Failed to toggle pin:', e);
    }
  };

  // Keyboard navigation handlers using sortedClips
  const handleNavigateLeft = useCallback(() => {
    if (sortedClips.length === 0) return;

    if (!selectedClipId) {
      setSelectedClipId(sortedClips[0].id);
      return;
    }

    const currentIndex = sortedClips.findIndex((c) => c.id === selectedClipId);
    if (currentIndex > 0) {
      setSelectedClipId(sortedClips[currentIndex - 1].id);
    } else {
      setSelectedClipId(sortedClips[0].id);
    }
  }, [sortedClips, selectedClipId]);

  const handleNavigateRight = useCallback(() => {
    if (sortedClips.length === 0) return;

    if (!selectedClipId) {
      if (sortedClips.length > 1) {
        setSelectedClipId(sortedClips[1].id);
      } else {
        setSelectedClipId(sortedClips[0].id);
      }
      return;
    }

    const currentIndex = sortedClips.findIndex((c) => c.id === selectedClipId);
    if (currentIndex >= 0 && currentIndex < sortedClips.length - 1) {
      setSelectedClipId(sortedClips[currentIndex + 1].id);
    }
  }, [sortedClips, selectedClipId]);

  const handlePasteSelected = useCallback(() => {
    if (selectedClipId) {
      handlePaste(selectedClipId);
    } else if (sortedClips.length > 0) {
      handlePaste(sortedClips[0].id);
    }
  }, [selectedClipId, sortedClips, handlePaste]);

  useKeyboard({
    onClose: () => invoke('hide_window'),
    onSearch: () => setShowSearch(true),
    onOpenNotepad: () => openNotepad(),
    onDelete: () => handleDelete(selectedClipId),
    onPin: () => {
      const targetId = selectedClipId || (sortedClips.length > 0 ? sortedClips[0].id : null);
      if (targetId) handleTogglePin(targetId);
    },
    onNavigateLeft: handleNavigateLeft,
    onNavigateRight: handleNavigateRight,
    onPaste: handlePasteSelected,
    onPastePlainText: () => {
      const targetId = selectedClipId || (sortedClips.length > 0 ? sortedClips[0].id : null);
      if (targetId) handlePastePlainText(targetId);
    },
    onQuickPaste: (index: number) => {
      if (index >= 0 && index < sortedClips.length) {
        handlePaste(sortedClips[index].id);
      }
    },
  });

  const handleCreateFolder = async (name: string) => {
    try {
      await invoke('create_folder', { name, icon: null, color: null });
      await loadFolders();
    } catch (error) {
      console.error('Failed to create folder:', error);
    }
  };

  const handleRenameFolder = async (folderId: string, name: string) => {
    try {
      await invoke('rename_folder', { id: folderId, name });
      await loadFolders();
    } catch (error) {
      console.error('Failed to rename folder:', error);
    }
  };

  const handleCreateOrRenameFolder = async (name: string) => {
    if (folderModalMode === 'create') {
      await handleCreateFolder(name);
    } else if (folderModalMode === 'rename' && editingFolderId) {
      await handleRenameFolder(editingFolderId, name);
    }
    setShowAddFolderModal(false);
    setNewFolderName('');
    setEditingFolderId(null);
  };

  const handleDeleteFolder = async (folderId: string) => {
    try {
      await invoke('delete_folder', { id: folderId });
      toast.success(t('folders.folderDeleted'));
      if (selectedFolder === folderId) {
        setSelectedFolder(null);
      }
      await loadFolders();
      await loadClips(null);
    } catch (error) {
      console.error('Failed to delete folder:', error);
      toast.error(t('notifications.folderDeleteFailed'));
    }
  };

  const loadMore = useCallback(() => {
    if (hasMore && !isLoading) {
      loadClips(selectedFolder, true, searchQuery);
    }
  }, [hasMore, isLoading, selectedFolder, loadClips, searchQuery]);

  const handleMoveClip = async (clipId: string, folderId: string | null) => {
    try {
      await invoke('move_to_folder', { clipId, folderId });

      // Update local state to reflect the move
      if (selectedFolder) {
        // If we are in a specific folder (not All)
        if (folderId !== selectedFolder) {
          // If moved to a different folder, remove from current view
          setClips((prev) => prev.filter((c) => c.id !== clipId));
        }
      } else {
        // If we are in "All clips" view, just update the folder_id
        setClips((prev) => prev.map((c) => (c.id === clipId ? { ...c, folder_id: folderId } : c)));
      }
      // Refresh counts after move
      loadFolders();
      refreshTotalCount();
    } catch (error) {
      console.error('Failed to move clip:', error);
    }
  };

  // Context Menu State
  const [contextMenu, setContextMenu] = useState<{
    type: 'card' | 'folder';
    x: number;
    y: number;
    itemId: string;
  } | null>(null);

  // New Folder Modal Rename Mode
  const [folderModalMode, setFolderModalMode] = useState<'create' | 'rename'>('create');
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, type: 'card' | 'folder', itemId: string) => {
      e.preventDefault();
      setContextMenu({
        type,
        x: e.clientX,
        y: e.clientY,
        itemId,
      });
    },
    []
  );

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  return (
    <div data-el="app-root" className="relative h-screen w-full overflow-hidden">
      {/* Content Container */}
      <div
        data-el="app-window"
        className={`relative h-full w-full overflow-hidden ${settings?.mica_effect === 'clear' ? 'bg-background/95' : ''}`}
      >
        <div data-el="app-frame" className="flex h-full w-full flex-col font-sans text-foreground">
          {draggingClipId && (
            <DragPreview
              clip={clips.find((c) => c.id === draggingClipId)!}
              position={dragPosition}
            />
          )}

          {contextMenu && (
            <ContextMenu
              x={contextMenu.x}
              y={contextMenu.y}
              onClose={handleCloseContextMenu}
              options={(() => {
                if (contextMenu.type === 'folder') {
                  return [
                    {
                      label: t('contextMenu.rename'),
                      onClick: () => {
                        setFolderModalMode('rename');
                        setEditingFolderId(contextMenu.itemId);
                        const folder = folders.find((f) => f.id === contextMenu.itemId);
                        setNewFolderName(folder ? folder.name : '');
                        setShowAddFolderModal(true);
                      },
                    },
                    {
                      label: t('contextMenu.delete'),
                      danger: true,
                      onClick: () => handleDeleteFolder(contextMenu.itemId),
                    },
                  ];
                }

                const targetClip = clips.find((c) => c.id === contextMenu.itemId);
                const menuOptions: { label: string; onClick: () => void; danger?: boolean }[] = [];

                if (targetClip) {
                  const text = targetClip.content.trim();

                  // Smart Action: Open URL
                  if (/^https?:\/\/[^\s]+$/i.test(text)) {
                    menuOptions.push({
                      label: t('contextMenu.openUrl'),
                      onClick: () => openUrl(text),
                    });
                  }

                  // Smart Action: Format JSON
                  if (
                    (text.startsWith('{') && text.endsWith('}')) ||
                    (text.startsWith('[') && text.endsWith(']'))
                  ) {
                    try {
                      const parsed = JSON.parse(text);
                      const formatted = JSON.stringify(parsed, null, 2);
                      menuOptions.push({
                        label: t('contextMenu.formatJson'),
                        onClick: async () => {
                          await navigator.clipboard.writeText(formatted);
                          toast.success(t('common.copied'));
                        },
                      });
                    } catch {}
                  }

                  // Smart Action: Copy Color HEX
                  const hexMatch = text.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/i);
                  if (hexMatch) {
                    menuOptions.push({
                      label: t('contextMenu.copyColorHex'),
                      onClick: async () => {
                        await navigator.clipboard.writeText(text);
                        toast.success(t('common.copied'));
                      },
                    });
                  }

                  // Pin / Unpin
                  menuOptions.push({
                    label: targetClip.is_pinned ? t('contextMenu.unpin') : t('contextMenu.pin'),
                    onClick: () => handleTogglePin(targetClip.id),
                  });

                  // Plain text actions
                  if (targetClip.clip_type !== 'image') {
                    menuOptions.push({
                      label: t('contextMenu.pastePlainText'),
                      onClick: () => handlePastePlainText(targetClip.id),
                    });
                    menuOptions.push({
                      label: t('contextMenu.copyPlainText'),
                      onClick: () => handleCopyPlainText(targetClip),
                    });
                    menuOptions.push({
                      label: t('contextMenu.saveAsNote'),
                      onClick: async () => {
                        try {
                          await invoke('save_clip_as_note', { clipUuid: targetClip.id });
                          toast.success(t('notepad.noteCreated'));
                        } catch (err) {
                          console.error('Failed to save clip as note:', err);
                        }
                      },
                    });
                  }
                }

                menuOptions.push({
                  label: t('contextMenu.delete'),
                  danger: true,
                  onClick: () => handleDelete(contextMenu.itemId),
                });

                return menuOptions;
              })()}
            />
          )}

          <ControlBar
            style={{ height: LAYOUT.CONTROL_BAR_HEIGHT, flexShrink: 0 }}
            folders={folders}
            selectedFolder={selectedFolder}
            onSelectFolder={handleSelectFolder}
            sortMode={sortMode}
            onSortChange={setSortMode}
            showSearch={showSearch}
            searchQuery={searchQuery}
            onSearchChange={handleSearch}
            onSearchClick={() => {
              if (showSearch) {
                handleSearch(''); // Clear search when closing
              }
              setShowSearch(!showSearch);
            }}
            onAddClick={() => {
              setFolderModalMode('create');
              setNewFolderName('');
              setShowAddFolderModal(true);
            }}
            onNotepadClick={() => openNotepad()}
            onMoreClick={openSettings}
            onMoveClip={handleMoveClip} // Legacy, but kept for interface
            // Simulated Drag Props
            isDragging={!!draggingClipId}
            dragTargetFolderId={dragTargetFolderId}
            onDragHover={handleDragHover}
            onDragLeave={handleDragLeave}
            totalClipCount={totalClipCount}
            onFolderContextMenu={(e, folderId) => {
              if (folderId) handleContextMenu(e, 'folder', folderId);
            }}
            theme={effectiveTheme}
          />

          <main data-el="clip-list-area" className="no-scrollbar relative flex-1 overflow-hidden">
            <ClipList
              clips={sortedClips}
              isLoading={isLoading}
              hasMore={hasMore}
              resetToken={clipListResetToken}
              selectedClipId={selectedClipId}
              onSelectClip={setSelectedClipId}
              onPaste={handlePaste}
              onCopy={handleCopy}
              onDelete={handleDelete}
              onLoadMore={loadMore}
              // Simulated Drag Props
              onDragStart={startDrag}
              onCardContextMenu={(e, clipId) => handleContextMenu(e, 'card', clipId)}
              onTogglePin={handleTogglePin}
            />

            {/* Add/Rename Folder Modal Overlay */}
            <FolderModal
              isOpen={showAddFolderModal}
              mode={folderModalMode}
              initialName={newFolderName}
              onClose={() => {
                setShowAddFolderModal(false);
                setNewFolderName('');
              }}
              onSubmit={handleCreateOrRenameFolder}
            />
          </main>
          <Toaster richColors position="bottom-center" theme={effectiveTheme} />
        </div>
      </div>
    </div>
  );
}

export default App;
