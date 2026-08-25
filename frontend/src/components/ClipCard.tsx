import { ClipboardItem } from '../types';
import { clsx } from 'clsx';
import { useMemo, memo, useState, forwardRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { LAYOUT, COLUMN_WIDTH, PREVIEW_CHAR_LIMIT } from '../constants';
import { Copy, Check, Pin, Globe, FileCode, Palette } from 'lucide-react';
import { useMotionValue, useMotionTemplate, motion } from 'framer-motion';

interface ClipCardProps {
  clip: ClipboardItem;
  index?: number;
  isSelected: boolean;
  onSelect: () => void;
  onPaste: () => void;
  onCopy: () => void;
  onTogglePin?: () => void;
  onDragStart: (clipId: string, startX: number, startY: number) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
}

export const ClipCard = memo(
  forwardRef<HTMLDivElement, ClipCardProps>(function ClipCard(
    { clip, index, isSelected, onSelect, onPaste, onCopy, onTogglePin, onDragStart, onContextMenu }: ClipCardProps,
    ref
  ) {
    const { t } = useTranslation();
    const [copied, setCopied] = useState(false);
    const [hovered, setHovered] = useState(false);
    const title = clip.source_app || clip.clip_type.toUpperCase();

    const mouseX = useMotionValue(0);
    const mouseY = useMotionValue(0);

    const imageSrc = useMemo(() => {
      if (clip.clip_type !== 'image' || !clip.content) return null;
      const value = clip.content;
      const isAbsolutePath = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value);
      if (
        value.startsWith('data:') ||
        value.startsWith('http://') ||
        value.startsWith('https://') ||
        value.startsWith('asset:') ||
        value.startsWith('tauri://')
      ) {
        return value;
      }
      if (isAbsolutePath) {
        return convertFileSrc(value);
      }
      return `data:image/png;base64,${value}`;
    }, [clip.clip_type, clip.content]);

    const imageSizeKb = useMemo(() => {
      if (clip.clip_type !== 'image') return 0;
      try {
        const parsed = clip.metadata
          ? (JSON.parse(clip.metadata) as { size_bytes?: number })
          : null;
        if (parsed?.size_bytes && parsed.size_bytes > 0) {
          return Math.round(parsed.size_bytes / 1024);
        }
      } catch {
        // Ignore invalid metadata and fall back to zero.
      }
      return 0;
    }, [clip.clip_type, clip.metadata]);

    // Smart content detection
    const smartContent = useMemo(() => {
      if (clip.clip_type === 'image') return null;
      const text = clip.content.trim();
      const hexMatch = text.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/i);
      const rgbMatch = text.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/i);
      if (hexMatch || rgbMatch) {
        return { type: 'color' as const, color: text };
      }
      if (/^https?:\/\/[^\s]+$/i.test(text)) {
        return { type: 'url' as const, url: text };
      }
      if (
        (text.startsWith('{') && text.endsWith('}')) ||
        (text.startsWith('[') && text.endsWith(']'))
      ) {
        try {
          const parsed = JSON.parse(text);
          const formatted = JSON.stringify(parsed, null, 2);
          return { type: 'json' as const, formatted };
        } catch {}
      }
      return null;
    }, [clip.clip_type, clip.content]);

    // Memoize the content rendering
    const renderedContent = useMemo(() => {
      if (clip.clip_type === 'image') {
        return (
          <div className="flex h-full w-full select-none items-center justify-center">
            {clip.content ? (
              <img
                src={imageSrc ?? undefined}
                alt="Clipboard Image"
                className="max-h-full max-w-full object-contain"
              />
            ) : (
              <span className="text-xs text-muted-foreground/70">Image</span>
            )}
          </div>
        );
      }

      if (smartContent?.type === 'color') {
        return (
          <div className="flex h-full flex-col justify-center gap-2">
            <div
              className="h-16 w-full rounded-xl border border-black/10 shadow-inner flex items-center justify-center text-xs font-bold font-mono tracking-wider drop-shadow"
              style={{ backgroundColor: smartContent.color }}
            />
            <div className="flex items-center gap-1.5 text-xs font-mono font-medium text-foreground/90">
              <Palette size={13} className="text-muted-foreground" />
              <span>{smartContent.color}</span>
            </div>
          </div>
        );
      }

      if (smartContent?.type === 'url') {
        return (
          <div className="flex h-full flex-col gap-1.5">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-sky-500">
              <Globe size={13} />
              <span>URL</span>
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[13px] leading-tight text-foreground underline decoration-sky-400/30">
              <span>{clip.content.substring(0, PREVIEW_CHAR_LIMIT)}</span>
            </pre>
          </div>
        );
      }

      if (smartContent?.type === 'json') {
        return (
          <div className="flex h-full flex-col gap-1">
            <div className="flex items-center gap-1 text-[11px] font-semibold text-emerald-500">
              <FileCode size={13} />
              <span>JSON</span>
            </div>
            <pre className="whitespace-pre-wrap break-all font-mono text-[12px] leading-tight text-foreground/90">
              <span>{smartContent.formatted.substring(0, PREVIEW_CHAR_LIMIT)}</span>
            </pre>
          </div>
        );
      }

      return (
        <pre className="whitespace-pre-wrap break-all font-mono text-[13px] leading-tight text-foreground">
          <span>{clip.content.substring(0, PREVIEW_CHAR_LIMIT)}</span>
        </pre>
      );
    }, [clip.clip_type, clip.content, imageSrc, smartContent]);

    // Generate stable color index based on source app name
    const getAppColorIndex = (name: string) => {
      let hash = 0;
      for (let i = 0; i < name.length; i++) {
        hash = name.charCodeAt(i) + ((hash << 5) - hash);
      }
      return Math.abs(hash) % 15;
    };

    const appHue = useMemo(() => {
      const index = getAppColorIndex(title);
      const hueStep = 360 / 15;
      return Math.round(index * hueStep);
    }, [title]);

    const glowBackground = useMotionTemplate`radial-gradient(180px circle at ${mouseX}px ${mouseY}px, hsl(${appHue} 90% 64% / 0.9), transparent 65%)`;

    const handleMouseDown = (e: React.MouseEvent) => {
      // Only left click
      if (e.button !== 0) return;
      onDragStart(clip.id, e.clientX, e.clientY);
    };

    const handleContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu?.(e);
    };

    const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      mouseX.set(e.clientX - rect.left);
      mouseY.set(e.clientY - rect.top);
    };

    return (
      <div
        ref={ref}
        data-el="clip-card"
        data-clip-id={clip.id}
        style={{
          width: COLUMN_WIDTH - LAYOUT.CARD_GAP,
          height: `calc(100% - ${LAYOUT.CARD_VERTICAL_PADDING * 2}px)`,
        }}
        className="flex-shrink-0"
      >
        <div
          data-el="clip-card-inner"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onClick={onSelect}
          onDoubleClick={onPaste}
          onContextMenu={handleContextMenu}
          style={
            {
              '--app-hue': `${appHue}`,
              borderColor: isSelected ? `hsl(${appHue} 82% 60%)` : undefined,
              borderWidth: isSelected ? '2px' : undefined,
            } as React.CSSProperties
          }
          className={clsx(
            'relative flex h-full w-full cursor-pointer select-none flex-col overflow-hidden rounded-2xl border border-border bg-card/80 shadow-lg transition-all',
            isSelected ? 'z-10 scale-[1.02] transform' : 'hover:-translate-y-1',
            'group'
          )}
        >
          {/* Framer-motion spotlight border glow */}
          {!isSelected && (
            <motion.div
              data-el="clip-card-glow"
              className="pointer-events-none absolute -inset-px z-20 rounded-[17px] p-[2px]"
              style={{
                background: glowBackground,
                WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                WebkitMaskComposite: 'xor',
                maskComposite: 'exclude',
                opacity: hovered ? 1 : 0,
                transition: 'opacity 200ms',
              }}
            />
          )}

          <div
            data-el="clip-card-header"
            className="relative z-10 flex flex-shrink-0 items-center gap-2 px-2 py-1.5"
            style={{ backgroundColor: `hsl(${appHue} 82% 60%)` }}
          >
            {clip.source_icon && (
              <img
                src={`data:image/png;base64,${clip.source_icon}`}
                alt=""
                className="h-4 w-4 object-contain"
              />
            )}
            <span className="flex-1 truncate text-[11px] font-bold uppercase tracking-wider text-foreground">
              {title}
            </span>

            {/* Quick number shortcut badge (1-9) */}
            {index !== undefined && index < 9 && (
              <span
                data-el="clip-card-shortcut-badge"
                className="rounded bg-black/20 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white/90 shadow-sm"
                title={`Press ${index + 1} to paste`}
              >
                {index + 1}
              </span>
            )}

            {/* Pin Toggle Button */}
            <button
              data-el="clip-card-pin-btn"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin?.();
              }}
              className={clsx(
                'rounded-md p-1 transition-all hover:bg-black/10',
                clip.is_pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              title={clip.is_pinned ? t('contextMenu.unpin') : t('contextMenu.pin')}
            >
              <Pin
                size={14}
                className={clsx(
                  'transition-transform',
                  clip.is_pinned
                    ? 'fill-amber-400 text-amber-500 rotate-45'
                    : 'text-foreground/70 hover:text-foreground'
                )}
              />
            </button>

            <button
              data-el="clip-card-copy-btn"
              onClick={(e) => {
                e.stopPropagation();
                onCopy();
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="rounded-md p-1 opacity-0 transition-all hover:bg-black/10 group-hover:opacity-100"
              title="Copy to clipboard"
            >
              {copied ? (
                <Check size={14} className="text-emerald-500" />
              ) : (
                <Copy size={14} className="text-foreground/70 hover:text-foreground" />
              )}
            </button>
          </div>

          <div data-el="clip-card-content" className="relative z-10 flex-1 overflow-hidden bg-card/90 p-2">
            {renderedContent}
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-card/100 to-card/30" />
          </div>

          <div data-el="clip-card-footer" className="absolute bottom-0 left-0 right-0 z-10 bg-gradient-to-t from-card via-card/100 to-transparent/0 px-3 py-1.5">
            <span className="text-[11px] font-medium text-muted-foreground/50">
              {clip.clip_type === 'image'
                ? t('clipList.imageSize', { size: imageSizeKb })
                : t('clipList.textLength', { count: clip.content.length })}
            </span>
          </div>
        </div>
      </div>
    );
  })
);
