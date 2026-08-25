import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface ContextMenuProps {
  x: number;
  y: number;
  options: {
    label: string;
    onClick: () => void;
    danger?: boolean;
    disabled?: boolean;
  }[];
  onClose: () => void;
}

export function ContextMenu({ x, y, options, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: y, left: x });

  useLayoutEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const margin = 8;
      let newTop = y;
      let newLeft = x;

      // Flip upward if extending below viewport
      if (y + rect.height > window.innerHeight - margin) {
        newTop = y - rect.height;
        // If flipping up also overflows top, clamp within window
        if (newTop < margin) {
          newTop = Math.max(margin, window.innerHeight - rect.height - margin);
        }
      }

      // Clamp or shift left if extending beyond right edge
      if (x + rect.width > window.innerWidth - margin) {
        newLeft = Math.max(margin, window.innerWidth - rect.width - margin);
      }

      setPosition({ top: Math.max(margin, newTop), left: Math.max(margin, newLeft) });
    }
  }, [x, y, options]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    // Handle Escape key
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="animate-in fade-in-0 zoom-in-95 fixed z-50 min-w-[12.5rem] max-h-[calc(100vh-16px)] overflow-y-auto no-scrollbar rounded-xl border border-border bg-popover/95 backdrop-blur-md p-1.5 shadow-2xl"
      style={{ top: position.top, left: position.left }}
    >
      <div className="flex flex-col gap-0.5">
        {options.map((option, index) => (
          <button
            key={index}
            disabled={option.disabled}
            onClick={() => {
              option.onClick();
              onClose();
            }}
            className={`relative flex cursor-pointer select-none items-center rounded-lg px-2.5 py-1.5 text-xs font-medium outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 ${
              option.danger
                ? 'text-red-400 hover:bg-red-500/10 hover:text-red-400'
                : 'text-foreground'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
