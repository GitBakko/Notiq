import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { KanbanColumn } from '../types';

interface BulkMoveMenuProps {
  selectedCount: number;
  position: { x: number; y: number };
  columns: KanbanColumn[];
  onMove: (targetColumnId: string) => void;
  onCancel: () => void;
}

const MENU_WIDTH = 260;
const MENU_MARGIN = 8;

export default function BulkMoveMenu({
  selectedCount,
  position,
  columns,
  onMove,
  onCancel,
}: BulkMoveMenuProps) {
  const { t } = useTranslation();
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const mountedAtRef = useRef(Date.now());

  // Viewport-bounded positioning
  const getAdjustedPosition = useCallback(() => {
    const menuEl = menuRef.current;
    if (!menuEl) return { left: position.x, top: position.y };

    const rect = menuEl.getBoundingClientRect();
    let left = position.x;
    let top = position.y;

    if (left + MENU_WIDTH > window.innerWidth - MENU_MARGIN) {
      left = window.innerWidth - MENU_WIDTH - MENU_MARGIN;
    }
    if (left < MENU_MARGIN) {
      left = MENU_MARGIN;
    }
    if (top + rect.height > window.innerHeight - MENU_MARGIN) {
      top = window.innerHeight - rect.height - MENU_MARGIN;
    }
    if (top < MENU_MARGIN) {
      top = MENU_MARGIN;
    }

    return { left, top };
  }, [position]);

  const [adjustedPos, setAdjustedPos] = useState({ left: position.x, top: position.y });

  useEffect(() => {
    // Recalculate after first render when menuRef is available
    requestAnimationFrame(() => {
      setAdjustedPos(getAdjustedPosition());
    });
  }, [getAdjustedPosition]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  // Close on click outside (with 100ms delay to avoid triggering mouseup)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (Date.now() - mountedAtRef.current < 100) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCancel();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onCancel]);

  const handleMove = () => {
    if (selectedColumnId) {
      onMove(selectedColumnId);
    }
  };

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      aria-modal="true"
      aria-label={t('kanban.card.bulkMove.title', { count: selectedCount })}
      className="fixed z-[100] w-[260px] bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden"
      style={{ left: adjustedPos.left, top: adjustedPos.top }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-neutral-200 dark:border-neutral-700">
        <span className="text-sm font-medium text-neutral-900 dark:text-white">
          {t('kanban.card.bulkMove.title', { count: selectedCount })}
        </span>
      </div>

      {/* Column list */}
      <div className="px-3 py-3 space-y-1">
        <span className="block px-1 pb-1 text-xs font-medium text-neutral-500 dark:text-neutral-400">
          {t('kanban.card.bulkMove.moveTo')}
        </span>
        {columns.map((col) => (
          <button
            key={col.id}
            type="button"
            onClick={() => setSelectedColumnId(col.id)}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors min-h-[44px] ${
              selectedColumnId === col.id
                ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 ring-1 ring-blue-500/30'
                : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700'
            }`}
          >
            <span className="truncate">{col.title}</span>
            <span className="ml-2 text-xs text-neutral-400 dark:text-neutral-500">
              {col.cards.length}
            </span>
          </button>
        ))}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-neutral-200 dark:border-neutral-700 px-4 py-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg px-3 py-1.5 text-sm font-medium bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-600 transition-colors min-h-[44px]"
        >
          {t('kanban.card.bulkMove.cancel')}
        </button>
        <button
          type="button"
          onClick={handleMove}
          disabled={!selectedColumnId}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors min-h-[44px] ${
            selectedColumnId
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 cursor-not-allowed'
          }`}
        >
          {t('kanban.card.bulkMove.move')}
        </button>
      </div>
    </div>,
    document.body
  );
}
