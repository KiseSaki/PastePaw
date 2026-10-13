import { invoke } from '@tauri-apps/api/core';
import { Editor, Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {
  NodeViewContent,
  NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
} from '@tiptap/react';
import { common, createLowlight } from 'lowlight';
import { Copy, Download, Paperclip } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import i18n from '../i18n/config';
import { useTranslation } from 'react-i18next';

export type NoteAsset = { hash: string; name: string; mime: string; size: number };
const attr = (name: string, fallback: unknown) => ({
  default: fallback,
  parseHTML: (el: HTMLElement) => el.getAttribute(`data-${name}`) ?? fallback,
  renderHTML: (attrs: Record<string, unknown>) => ({ [`data-${name}`]: attrs[name] }),
});
const assetAttributes = {
  asset: attr('asset', null),
  name: attr('name', ''),
  mime: attr('mime', ''),
  size: attr('size', 0),
};

function AssetView({ node, selected }: NodeViewProps) {
  const { t } = useTranslation();
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const image = node.type.name === 'image';
  useEffect(() => {
    let active = true;
    setSrc('');
    setError('');
    if (image && /^[a-f0-9]{64}$/.test(node.attrs.asset || '')) {
      invoke<string>('read_note_asset', { hash: node.attrs.asset })
        .then((value) => {
          if (active) setSrc(value);
        })
        .catch(() => {
          if (active) setError(t('notepad.editor.missingImage'));
        });
    } else if (image) setError(t('notepad.editor.importImage'));
    return () => {
      active = false;
    };
  }, [node.attrs.asset, image]);
  const download = () =>
    invoke('save_note_asset', {
      hash: node.attrs.asset,
      name: node.attrs.name || t('notepad.editor.attachment'),
    }).catch((err) => toast.error(String(err)));
  return (
    <NodeViewWrapper
      className={`note-asset ${selected ? 'is-selected' : ''}`}
      contentEditable={false}
    >
      {image ? (
        src ? (
          <img src={src} alt={node.attrs.alt || node.attrs.name} />
        ) : (
          <span>{error || t('notepad.editor.loadingImage')}</span>
        )
      ) : (
        <Paperclip size={16} />
      )}
      <div className="note-asset-caption">
        <span>{node.attrs.name || node.attrs.alt || t('notepad.editor.attachment')}</span>
        {node.attrs.size > 0 && <small>{(Number(node.attrs.size) / 1024).toFixed(1)} KB</small>}
        <button type="button" title={t('notepad.editor.saveAsset')} onClick={download}>
          <Download size={13} />
        </button>
      </div>
    </NodeViewWrapper>
  );
}
export const NoteImage = Image.extend({
  addAttributes() {
    return { ...this.parent?.(), ...assetAttributes };
  },
  addNodeView() {
    return ReactNodeViewRenderer(AssetView);
  },
});
export const Attachment = Node.create({
  name: 'attachment',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return assetAttributes;
  },
  parseHTML() {
    return [{ tag: 'div[data-type="attachment"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'attachment' }),
      HTMLAttributes['data-name'] || i18n.t('notepad.editor.attachment'),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(AssetView);
  },
});

export async function insertFiles(editor: Editor, files: File[]) {
  // 异步导入期间切换便签时不把附件插到另一张便签中。
  const originalDoc = editor.state.doc;
  const bookmark = editor.state.selection.getBookmark();
  const content = [];
  for (const file of files) {
    if (file.size === 0 || file.size > 20 * 1024 * 1024) {
      toast.error(i18n.t('notepad.editor.assetLimit', { name: file.name }));
      continue;
    }
    try {
      const asset = await invoke<NoteAsset>('store_note_asset', {
        bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
        name: file.name,
        mime: file.type,
      });
      const attrs = {
        asset: asset.hash,
        name: asset.name,
        size: asset.size,
        mime: asset.mime,
        src: `pastepaw-asset:${asset.hash}`,
        alt: asset.name,
      };
      content.push({ type: asset.mime.startsWith('image/') ? 'image' : 'attachment', attrs });
    } catch (err) {
      toast.error(String(err));
    }
  }
  if (editor.isDestroyed || editor.state.doc !== originalDoc || !content.length) {
    if (content.length) toast.info(i18n.t('notepad.editor.docChanged'));
    return;
  }
  editor.view.dispatch(editor.state.tr.setSelection(bookmark.resolve(editor.state.doc)));
  editor.chain().focus().insertContent(content).run();
}

const lowlight = createLowlight(common);
function CodeView({ node, updateAttributes }: NodeViewProps) {
  const { t } = useTranslation();
  return (
    <NodeViewWrapper className="note-code-frame">
      <div className="note-code-toolbar" contentEditable={false}>
        <select
          aria-label={t('notepad.editor.codeLanguage')}
          value={node.attrs.language || ''}
          onChange={(e) => updateAttributes({ language: e.target.value || null })}
        >
          <option value="">{t('notepad.editor.plainCode')}</option>
          {lowlight.listLanguages().map((language) => (
            <option key={language} value={language}>
              {language}
            </option>
          ))}
        </select>
        <button
          type="button"
          title={t('notepad.editor.copyCode')}
          onClick={() =>
            navigator.clipboard
              .writeText(node.textContent)
              .then(() => toast.success(t('notepad.editor.codeCopied')))
              .catch(() => toast.error(t('notepad.editor.copyFailed')))
          }
        >
          <Copy size={13} />
          {t('notepad.editor.copy')}
        </button>
      </div>
      <pre>
        <NodeViewContent<'code'>
          as="code"
          className={node.attrs.language ? `language-${node.attrs.language}` : ''}
        />
      </pre>
    </NodeViewWrapper>
  );
}
export const NoteCodeBlock = CodeBlockLowlight.extend({
  addNodeView() {
    return ReactNodeViewRenderer(CodeView);
  },
}).configure({ lowlight });
