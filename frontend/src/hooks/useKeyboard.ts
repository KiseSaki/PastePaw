import { useEffect } from 'react';

interface KeyboardOptions {
  onClose?: () => void;
  onSearch?: () => void;
  onDelete?: () => void;
  onPin?: () => void;
  onNavigateLeft?: () => void;
  onNavigateRight?: () => void;
  onPaste?: () => void;
  onPastePlainText?: () => void;
  onQuickPaste?: (index: number) => void;
}

export function useKeyboard(options: KeyboardOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInputFocused =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === 'Escape' && options.onClose) {
        e.preventDefault();
        options.onClose();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F') && options.onSearch) {
        e.preventDefault();
        options.onSearch();
        return;
      }

      // Quick Paste with Ctrl+1..9 (works even when input focused)
      if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '9' && options.onQuickPaste) {
        e.preventDefault();
        const index = parseInt(e.key, 10) - 1;
        options.onQuickPaste(index);
        return;
      }

      // Plain Text Paste: Shift + Enter
      if (e.shiftKey && e.key === 'Enter' && options.onPastePlainText) {
        e.preventDefault();
        options.onPastePlainText();
        return;
      }

      // Normal Paste: Enter
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && options.onPaste) {
        if (!isInputFocused) {
          e.preventDefault();
          options.onPaste();
          return;
        }
      }

      // The following shortcuts only trigger when input is NOT focused
      if (isInputFocused) return;

      // Direct number key paste: 1..9
      if (e.key >= '1' && e.key <= '9' && !e.ctrlKey && !e.metaKey && !e.altKey && options.onQuickPaste) {
        e.preventDefault();
        const index = parseInt(e.key, 10) - 1;
        options.onQuickPaste(index);
        return;
      }

      if (e.key === 'Delete' && options.onDelete) {
        e.preventDefault();
        options.onDelete();
        return;
      }

      if ((e.key === 'p' || e.key === 'P') && !e.metaKey && !e.ctrlKey && options.onPin) {
        e.preventDefault();
        options.onPin();
        return;
      }

      if (e.key === 'ArrowLeft' && options.onNavigateLeft) {
        e.preventDefault();
        options.onNavigateLeft();
        return;
      }

      if (e.key === 'ArrowRight' && options.onNavigateRight) {
        e.preventDefault();
        options.onNavigateRight();
        return;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [options]);
}
