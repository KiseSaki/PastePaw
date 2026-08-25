export type SortMode = 'time_desc' | 'time_asc' | 'app' | 'type' | 'length';

export interface ClipboardItem {
  id: string;
  clip_type: string;
  content: string;
  preview: string;
  folder_id: string | null;
  is_pinned?: boolean;
  created_at: string;
  source_app: string | null;
  source_icon: string | null;
  metadata: string | null;
}

export interface FolderItem {
  id: string;
  name: string;
  icon: string | null;
  color: string | null;
  is_system: boolean;
  item_count: number;
}

export interface Settings {
  max_items: number;
  auto_delete_days: number;
  startup_with_windows: boolean;
  show_in_taskbar: boolean;
  hotkey: string;
  theme: string;
  language?: string;
  mica_effect?: string;
  round_corners?: boolean;
  float_above_taskbar?: boolean;
  auto_paste: boolean;
  ignore_ghost_clips: boolean;
}

export type ClipType = 'text' | 'image' | 'html' | 'rtf' | 'file' | 'url';

export const CLIP_TYPE_LABELS: Record<ClipType, string> = {
  text: 'Text',
  image: 'Image',
  html: 'HTML',
  rtf: 'Rich Text',
  file: 'File',
  url: 'URL',
};

export const CLIP_TYPE_ICONS: Record<ClipType, string> = {
  text: 'FileText',
  image: 'Image',
  html: 'Code',
  rtf: 'Type',
  file: 'File',
  url: 'Link',
};

export interface NoteItem {
  id: string;
  title: string;
  content: string;
  color: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export const NOTE_COLORS: {
  id: string;
  name: string;
  bg: string;
  border: string;
  activeRing: string;
  dot: string;
}[] = [
  {
    id: 'default',
    name: 'Default',
    bg: 'bg-card/90',
    border: 'border-border/60',
    activeRing: 'ring-border',
    dot: 'bg-muted-foreground',
  },
  {
    id: 'amber',
    name: 'Amber',
    bg: 'bg-amber-500/10 dark:bg-amber-500/15',
    border: 'border-amber-500/30',
    activeRing: 'ring-amber-500/50',
    dot: 'bg-amber-500',
  },
  {
    id: 'emerald',
    name: 'Emerald',
    bg: 'bg-emerald-500/10 dark:bg-emerald-500/15',
    border: 'border-emerald-500/30',
    activeRing: 'ring-emerald-500/50',
    dot: 'bg-emerald-500',
  },
  {
    id: 'sky',
    name: 'Sky',
    bg: 'bg-sky-500/10 dark:bg-sky-500/15',
    border: 'border-sky-500/30',
    activeRing: 'ring-sky-500/50',
    dot: 'bg-sky-500',
  },
  {
    id: 'purple',
    name: 'Purple',
    bg: 'bg-purple-500/10 dark:bg-purple-500/15',
    border: 'border-purple-500/30',
    activeRing: 'ring-purple-500/50',
    dot: 'bg-purple-500',
  },
  {
    id: 'rose',
    name: 'Rose',
    bg: 'bg-rose-500/10 dark:bg-rose-500/15',
    border: 'border-rose-500/30',
    activeRing: 'ring-rose-500/50',
    dot: 'bg-rose-500',
  },
];
