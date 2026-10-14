import { invoke } from '@tauri-apps/api/core';
import { useEditor, EditorContent } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { X, GitMerge } from 'lucide-react';
import { toast } from 'sonner';
import { noteExtensions } from '../editor/extensions';
import { ensureHtmlContent } from '../utils/notepadMarkdown';
import { useTranslation } from 'react-i18next';
import { EditorTools } from '../editor/EditorTools';

type Snapshot = {
  id: string;
  title: string;
  content: string;
  deleted: boolean;
  fingerprint: string;
};
export type NoteConflict = {
  id: string;
  space_id: string;
  source: string;
  original: Snapshot;
  other: Snapshot;
  base_content: string | null;
};
function ReadVersion({ value }: { value: Snapshot }) {
  const { t } = useTranslation();
  const editor = useEditor({
    extensions: noteExtensions(),
    content: ensureHtmlContent(value.content),
    editable: false,
  });
  useEffect(() => {
    editor?.commands.setContent(ensureHtmlContent(value.content), { emitUpdate: false });
  }, [editor, value.content]);
  return (
    <div className="note-conflict-version">
      <h4>{value.title || t('notepad.untitled')}</h4>
      {value.deleted ? <p>{t('notepad.conflicts.deleted')}</p> : <EditorContent editor={editor} />}
    </div>
  );
}
export function NoteConflictDialog({
  conflicts,
  close,
  refresh,
}: {
  conflicts: NoteConflict[];
  close: () => void;
  refresh: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState(conflicts[0]?.id);
  const item = conflicts.find((c) => c.id === selected) || conflicts[0];
  const [busy, setBusy] = useState(false),
    [merging, setMerging] = useState(false),
    [title, setTitle] = useState('');
  const editor = useEditor({ extensions: noteExtensions(), content: '<p></p>' });
  useEffect(() => {
    editor?.setEditable(!busy);
  }, [editor, busy]);
  useEffect(() => {
    setMerging(false);
    if (item) {
      setTitle(item.original.deleted ? item.other.title : item.original.title);
      editor?.commands.setContent(
        ensureHtmlContent(item.original.deleted ? item.other.content : item.original.content)
      );
    }
  }, [item?.id, editor]);
  const resolve = async (choice: string) => {
    if (!item || busy) return;
    setBusy(true);
    try {
      await invoke('resolve_note_conflict', {
        resolution: {
          space_id: item.space_id,
          id: item.id,
          original_fingerprint: item.original.fingerprint,
          other_fingerprint: item.other.fingerprint,
          choice,
          title: choice === 'merge' ? title : null,
          content: choice === 'merge' ? editor?.getHTML() : null,
        },
      });
      await refresh();
      toast.success(t('notepad.conflicts.resolved'));
    } catch (error) {
      toast.error(String(error));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className="note-conflict-backdrop"
      role="presentation"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (!busy) close();
        }
      }}
    >
      <section
        className="note-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('notepad.conflicts.title')}
      >
        <header>
          <GitMerge size={17} />
          <strong>{t('notepad.conflicts.title')}</strong>
          <button type="button" aria-label={t('common.close')} disabled={busy} onClick={close}>
            <X size={17} />
          </button>
        </header>
        {!item ? (
          <p>{t('notepad.conflicts.empty')}</p>
        ) : (
          <>
            <select
              aria-label={t('notepad.conflicts.choose')}
              value={item.id}
              disabled={busy}
              onChange={(e) => setSelected(e.target.value)}
            >
              {conflicts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.original.deleted ? c.other.title : c.original.title} ·{' '}
                  {c.source === 'siyuan'
                    ? t('notepad.conflicts.siyuan')
                    : t('notepad.conflicts.devices')}
                </option>
              ))}
            </select>
            <p>{t('notepad.conflicts.help')}</p>
            <div className="note-conflict-compare">
              <div>
                <h3>{t('notepad.conflicts.original')}</h3>
                <ReadVersion value={item.original} />
              </div>
              <div>
                <h3>{t('notepad.conflicts.other')}</h3>
                <ReadVersion value={item.other} />
              </div>
            </div>
            <div className="note-conflict-actions">
              <button type="button" disabled={busy} onClick={() => resolve('keep_original')}>
                {item.original.deleted
                  ? t('notepad.conflicts.keepDeletion')
                  : t('notepad.conflicts.keepOriginal')}
              </button>
              <button type="button" disabled={busy} onClick={() => resolve('keep_other')}>
                {t('notepad.conflicts.keepOther')}
              </button>
              <button type="button" disabled={busy} onClick={() => resolve('keep_both')}>
                {t('notepad.conflicts.keepBoth')}
              </button>
              <button type="button" disabled={busy} onClick={() => setMerging(!merging)}>
                {t('notepad.conflicts.manual')}
              </button>
            </div>
            {merging && editor && (
              <div className="note-conflict-merge">
                <input
                  aria-label={t('notepad.titlePlaceholder')}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <EditorTools editor={editor} noteId={item.id} />
                <EditorContent editor={editor} />
                <button type="button" disabled={busy} onClick={() => resolve('merge')}>
                  {t('notepad.conflicts.saveMerge')}
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
