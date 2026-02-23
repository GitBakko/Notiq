import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import clsx from 'clsx';
import { MoreVertical, Plus, Trash2 } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import KanbanCard from './KanbanCard';
import { DEFAULT_COLUMN_KEYS } from '../types';
import type { KanbanColumn as KanbanColumnType } from '../types';

interface KanbanColumnProps {
  column: KanbanColumnType;
  boardId: string;
  onCardSelect: (cardId: string) => void;
  onRenameColumn: (columnId: string, title: string) => void;
  onDeleteColumn: (columnId: string) => void;
  onAddCard: (columnId: string, title: string) => void;
  readOnly?: boolean;
  highlightedCardIds?: Set<string>;
}

export default function KanbanColumn({
  column,
  boardId,
  onCardSelect,
  onRenameColumn,
  onDeleteColumn,
  onAddCard,
  readOnly,
  highlightedCardIds,
}: KanbanColumnProps) {
  const { t } = useTranslation();

  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(column.title);
  const [showMenu, setShowMenu] = useState(false);
  const [isAddingCard, setIsAddingCard] = useState(false);
  const [newCardTitle, setNewCardTitle] = useState('');

  const titleInputRef = useRef<HTMLInputElement>(null);
  const newCardInputRef = useRef<HTMLInputElement>(null);

  const { setNodeRef } = useDroppable({ id: column.id });

  const sortedCards = [...column.cards].sort((a, b) => a.position - b.position);
  const hasCards = column.cards.length > 0;

  // Resolve display title: use i18n key for default columns, raw title otherwise
  const translationKey = DEFAULT_COLUMN_KEYS[column.title];
  const displayTitle = translationKey ? t(translationKey) : column.title;

  // Focus title input when entering edit mode
  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  // Focus new card input when entering add mode
  useEffect(() => {
    if (isAddingCard && newCardInputRef.current) {
      newCardInputRef.current.focus();
    }
  }, [isAddingCard]);

  // Keep local edit title in sync with prop
  useEffect(() => {
    if (!isEditingTitle) {
      setEditTitle(column.title);
    }
  }, [column.title, isEditingTitle]);

  function handleSaveTitle(): void {
    setIsEditingTitle(false);
    const trimmed = editTitle.trim();
    if (trimmed && trimmed !== column.title) {
      onRenameColumn(column.id, trimmed);
    } else {
      setEditTitle(column.title);
    }
  }

  function handleAddCard(): void {
    const trimmed = newCardTitle.trim();
    if (!trimmed) return;
    onAddCard(column.id, trimmed);
    setNewCardTitle('');
    setIsAddingCard(false);
  }

  function handleCancelAdd(): void {
    setNewCardTitle('');
    setIsAddingCard(false);
  }

  return (
    <div className="min-w-[280px] w-[280px] flex-shrink-0 bg-gray-100 dark:bg-gray-800/50 rounded-xl flex flex-col max-h-full">
      {/* Header */}
      <div className="p-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isEditingTitle && !readOnly ? (
            <input
              ref={titleInputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveTitle();
                if (e.key === 'Escape') {
                  setIsEditingTitle(false);
                  setEditTitle(column.title);
                }
              }}
              className="w-full bg-transparent border-b-2 border-emerald-500 font-semibold text-sm text-gray-700 dark:text-gray-300 outline-none"
            />
          ) : (
            <h3
              onDoubleClick={() => !readOnly && setIsEditingTitle(true)}
              className={clsx(
                'font-semibold text-sm text-gray-700 dark:text-gray-300 truncate',
                !readOnly && 'cursor-pointer'
              )}
            >
              {displayTitle}
            </h3>
          )}

          {/* Card count badge */}
          <span className="flex-shrink-0 text-xs text-gray-400 dark:text-gray-500 bg-gray-200 dark:bg-gray-700 px-1.5 py-0.5 rounded-full">
            {column.cards.length}
          </span>
        </div>

        {/* Column menu */}
        {!readOnly && (
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 p-0.5 rounded transition-colors"
            >
              <MoreVertical size={16} />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-8 z-20 w-52 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1">
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      if (!hasCards) onDeleteColumn(column.id);
                    }}
                    disabled={hasCards}
                    className={clsx(
                      'flex items-center gap-2 w-full px-3 py-2 text-sm',
                      hasCards
                        ? 'text-gray-400 dark:text-gray-500 cursor-not-allowed'
                        : 'text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
                    )}
                    title={hasCards ? t('kanban.column.hasCards') : undefined}
                  >
                    <Trash2 size={14} />
                    {t('kanban.column.deleteColumn')}
                  </button>
                  {hasCards && (
                    <p className="px-3 py-1.5 text-xs text-gray-400 dark:text-gray-500">
                      {t('kanban.column.hasCards')}
                    </p>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Card list */}
      <div
        ref={setNodeRef}
        className="flex-1 overflow-y-auto p-2 space-y-2"
      >
        <SortableContext
          items={sortedCards.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          {sortedCards.map((card) => (
            <KanbanCard
              key={card.id}
              card={card}
              onSelect={onCardSelect}
              readOnly={readOnly}
              isHighlighted={highlightedCardIds?.has(card.id)}
            />
          ))}
        </SortableContext>

        {sortedCards.length === 0 && (
          <p className="text-center text-xs text-gray-400 dark:text-gray-500 py-4 italic">
            {t('kanban.card.addCard')}
          </p>
        )}
      </div>

      {/* Add card section */}
      {!readOnly && (
        <div className="p-2 border-t border-gray-200 dark:border-gray-700">
          {isAddingCard ? (
            <div className="space-y-2">
              <input
                ref={newCardInputRef}
                value={newCardTitle}
                onChange={(e) => setNewCardTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddCard();
                  if (e.key === 'Escape') handleCancelAdd();
                }}
                onBlur={handleCancelAdd}
                placeholder={t('kanban.card.cardTitle')}
                className="w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-1.5 text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none focus:border-emerald-500 dark:focus:border-emerald-400"
              />
            </div>
          ) : (
            <button
              onClick={() => setIsAddingCard(true)}
              className="flex items-center gap-1 w-full px-2 py-1.5 text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              <Plus size={16} />
              {t('kanban.card.addCard')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
