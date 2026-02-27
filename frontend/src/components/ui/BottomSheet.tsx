import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import clsx from 'clsx';
import { useIsMobile } from '../../hooks/useIsMobile';
import Modal from './Modal';

const DISMISS_THRESHOLD = 100;

interface BottomSheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

export default function BottomSheet({ isOpen, onClose, title, children, size = 'md' }: BottomSheetProps) {
  const isMobile = useIsMobile();
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartY = useRef<number | null>(null);
  const currentTranslateY = useRef(0);

  // Escape key — only needed on mobile (Modal handles its own)
  useEffect(() => {
    if (!isMobile || !isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMobile, isOpen, onClose]);

  // Prevent background scroll — only needed on mobile (Modal handles its own)
  useEffect(() => {
    if (!isMobile || !isOpen) return;

    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobile, isOpen]);

  // Touch drag-to-dismiss handlers
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
    currentTranslateY.current = 0;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (dragStartY.current === null || !sheetRef.current) return;

    const deltaY = e.touches[0].clientY - dragStartY.current;
    if (deltaY < 0) return; // Only allow dragging downward

    currentTranslateY.current = deltaY;
    sheetRef.current.style.transform = `translateY(${deltaY}px)`;
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (!sheetRef.current) return;

    if (currentTranslateY.current > DISMISS_THRESHOLD) {
      onClose();
    }

    sheetRef.current.style.transform = '';
    dragStartY.current = null;
    currentTranslateY.current = 0;
  }, [onClose]);

  // Desktop: delegate to standard centered Modal
  if (!isMobile) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title={title || ''} size={size}>
        {children}
      </Modal>
    );
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity"
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || 'Dialog'}
        className={clsx(
          'absolute bottom-0 left-0 right-0',
          'bg-white dark:bg-gray-900',
          'rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col',
          'safe-area-bottom',
        )}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* Drag Handle */}
        <div className="flex justify-center py-3 flex-shrink-0">
          <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600" />
        </div>

        {/* Title */}
        {title && (
          <div className="px-4 pb-3 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">{title}</h3>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {children}
        </div>
      </div>
    </div>
  );
}
