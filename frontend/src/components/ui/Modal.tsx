import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useFocusTrap } from '../../hooks/useFocusTrap';

const SIZE_CLASSES = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
} as const;

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  size?: keyof typeof SIZE_CLASSES;
  noPadding?: boolean;
  /** Mobile: bottom sheet (rounded-t-2xl, maniglia, max 90vh scrollabile); da `sm:` in su resta un modal centrato. */
  sheet?: boolean;
  children: React.ReactNode;
}

export default function Modal({ isOpen, onClose, title, size = 'md', noPadding = false, sheet = false, children }: ModalProps) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(modalRef, isOpen);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEscape);
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className={clsx('fixed inset-0 z-50 flex justify-center bg-neutral-950/60 backdrop-blur-sm animate-in fade-in duration-200', sheet ? 'items-end sm:items-center sm:p-4' : 'items-center p-4')}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby={title ? titleId : undefined} className={clsx('bg-white dark:bg-neutral-900 shadow-xl w-full animate-in zoom-in-95 duration-200 border border-neutral-200/60 dark:border-neutral-700/40', sheet ? 'rounded-t-2xl sm:rounded-xl max-h-[90vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]' : 'rounded-xl overflow-hidden', SIZE_CLASSES[size])}>
        {sheet && <div className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-neutral-300 dark:bg-neutral-600 sm:hidden" aria-hidden="true" />}
        <div className="flex items-center justify-between p-4 border-b border-neutral-200/60 dark:border-neutral-700/40">
          <h3 id={titleId} className="text-lg font-semibold tracking-tight text-neutral-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            aria-label={t('common.close')}
            className="text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors rounded-full p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-emerald-500/40"
          >
            <X size={20} />
          </button>
        </div>
        <div className={noPadding ? '' : 'p-6'}>
          {children}
        </div>
      </div>
    </div>
  );
}
