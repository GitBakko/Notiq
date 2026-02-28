import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}

export function Dialog({ isOpen, onClose, title, children, className }: DialogProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, isOpen);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    if (isOpen) {
      document.body.style.overflow = 'hidden';
      window.addEventListener('keydown', handleEscape);
    }

    return () => {
      document.body.style.overflow = 'unset';
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div
        className="absolute inset-0"
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "dialog-title" : undefined}
        className={cn("relative w-full max-w-lg rounded-xl bg-white p-6 shadow-xl animate-in zoom-in-95 duration-200 dark:bg-neutral-900 border border-neutral-200/60 dark:border-neutral-700/40", className)}
      >
        <div className="flex items-center justify-between mb-4">
            {title && <h2 id="dialog-title" className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-white">{title}</h2>}
            <button onClick={onClose} aria-label={t('common.close')} className="text-neutral-400 hover:text-neutral-600 transition-colors dark:text-neutral-500 dark:hover:text-neutral-300">
                <X size={20} />
            </button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
