import { useState, useRef, useCallback } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { formatDistanceToNow, isToday, isPast, startOfDay } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { CheckCircle2, MessageSquare, FileText, Calendar, MoreVertical, ArrowRightLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useIsMobile } from '../../../hooks/useIsMobile';
import type { KanbanCard as KanbanCardType, KanbanColumn } from '../types';
import { PRIORITY_CONFIG } from '../../../utils/priorityConfig';
import { DEFAULT_COLUMN_KEYS } from '../types';

interface KanbanCardProps {
  card: KanbanCardType;
  onSelect: (cardId: string) => void;
  readOnly?: boolean;
  isHighlighted?: boolean;
  isInCompletedColumn?: boolean;
  allColumns?: KanbanColumn[];
  currentColumnId?: string;
  onMoveToColumn?: (cardId: string, targetColumnId: string) => void;
}

function getDueDateStatus(dueDate: string): 'default' | 'today' | 'overdue' {
  const due = startOfDay(new Date(dueDate));
  if (isToday(due)) return 'today';
  if (isPast(due)) return 'overdue';
  return 'default';
}

export default function KanbanCard({ card, onSelect, readOnly, isHighlighted, isInCompletedColumn, allColumns, currentColumnId, onMoveToColumn }: KanbanCardProps) {
  const { t, i18n } = useTranslation();
  const isMobile = useIsMobile();
  const dateLocale = i18n.language.startsWith('it') ? itLocale : enUS;

  const [showMoveMenu, setShowMoveMenu] = useState(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id, disabled: readOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const dueDateStatus = card.dueDate ? getDueDateStatus(card.dueDate) : null;

  const otherColumns = allColumns?.filter(c => c.id !== currentColumnId) ?? [];
  const canMove = !readOnly && onMoveToColumn && otherColumns.length > 0;

  const handleMoveToColumn = useCallback((targetColumnId: string) => {
    setShowMoveMenu(false);
    onMoveToColumn?.(card.id, targetColumnId);
  }, [card.id, onMoveToColumn]);

  function translateColumnTitle(title: string): string {
    const key = DEFAULT_COLUMN_KEYS[title];
    return key ? t(key) : title;
  }

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleCardTouchStart = useCallback(() => {
    if (!canMove || !isMobile) return;
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null;
      longPressFiredRef.current = true;
      setShowMoveMenu(true);
    }, 600);
  }, [canMove, isMobile]);

  const handleCardTouchEnd = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleCardTouchMove = useCallback(() => {
    clearLongPress();
  }, [clearLongPress]);

  const handleCardClick = useCallback(() => {
    // If long press just fired the move menu, don't also open the detail modal
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    onSelect(card.id);
  }, [card.id, onSelect]);

  return (
    <>
      <div
        ref={setNodeRef}
        style={style}
        className={clsx(
          'rounded-lg bg-white dark:bg-neutral-800 p-3 shadow-sm',
          'border border-neutral-200/60 dark:border-neutral-700/40',
          'hover:shadow-md transition-all cursor-pointer hover-lift',
          isDragging && 'opacity-50 shadow-lg z-50',
          isHighlighted && 'ring-2 ring-emerald-400 dark:ring-emerald-500 animate-pulse shadow-md shadow-emerald-100 dark:shadow-emerald-900/30'
        )}
      >
        <div className="flex gap-2">
          {/* Drag handle — full card height bar */}
          {!readOnly && (
            <div
              data-dnd-handle
              {...attributes}
              {...listeners}
              className="flex-shrink-0 self-stretch w-1 rounded-full bg-neutral-200 dark:bg-neutral-700 hover:bg-neutral-400 dark:hover:bg-neutral-500 active:bg-neutral-500 dark:active:bg-neutral-400 cursor-grab active:cursor-grabbing touch-none transition-colors"
            />
          )}

          {/* Priority icon — left of title */}
          {card.priority && (() => {
            const PIcon = PRIORITY_CONFIG[card.priority].icon;
            return (
              <span
                className={clsx('mt-0.5 self-start flex-shrink-0', PRIORITY_CONFIG[card.priority].color)}
                title={t(`kanban.priority.${card.priority}`)}
              >
                <PIcon size={14} />
              </span>
            );
          })()}

          {/* Card body */}
          <div
            className="flex-1 min-w-0"
            onClick={handleCardClick}
            onTouchStart={handleCardTouchStart}
            onTouchEnd={handleCardTouchEnd}
            onTouchMove={handleCardTouchMove}
          >
            {/* Title row with three-dot menu */}
            <div className="flex items-start gap-1">
              <p className="text-sm font-medium text-neutral-900 dark:text-white line-clamp-2 flex-1 min-w-0">
                {card.title || t('kanban.card.untitled')}
              </p>

              {/* Three-dot menu — Move to column */}
              {canMove && (
                <div className="relative flex-shrink-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowMoveMenu(!showMoveMenu);
                    }}
                    onTouchEnd={(e) => {
                      // Prevent the card's touch handlers from interfering
                      e.stopPropagation();
                      clearLongPress();
                    }}
                    className={clsx(
                      'p-0.5 rounded text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors',
                      isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    )}
                    aria-label={t('kanban.card.moveToColumn')}
                  >
                    <MoreVertical size={14} />
                  </button>
                </div>
              )}
            </div>

            {/* Metadata row — only rendered when there's data to show */}
            {(card.assignee || card.dueDate || card.commentCount > 0 || card.noteId) && (
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                {/* Assignee */}
                {card.assignee && (
                  <span
                    className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400"
                    title={card.assignee.name || card.assignee.email}
                  >
                    {card.assignee.avatarUrl ? (
                      <img src={card.assignee.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')} alt="" className="w-4 h-4 rounded-full object-cover flex-shrink-0" loading="lazy" decoding="async" />
                    ) : (
                      <span
                        className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                        style={{ backgroundColor: card.assignee.color || '#6b7280' }}
                      >
                        {(card.assignee.name || card.assignee.email).charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="truncate max-w-[80px]">
                      {card.assignee.name || card.assignee.email.split('@')[0]}
                    </span>
                  </span>
                )}

                {/* Due date badge */}
                {card.dueDate && dueDateStatus && (
                  <span
                    className={clsx(
                      'flex items-center gap-1 text-xs px-1.5 py-0.5 rounded',
                      isInCompletedColumn
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : dueDateStatus === 'overdue' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        : dueDateStatus === 'today' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400'
                    )}
                  >
                    {isInCompletedColumn ? <CheckCircle2 size={12} /> : <Calendar size={12} />}
                    {formatDistanceToNow(new Date(card.dueDate), { addSuffix: true, locale: dateLocale })}
                  </span>
                )}

                {/* Comment count */}
                {card.commentCount > 0 && (
                  <span className="flex items-center gap-1 text-xs text-neutral-400 dark:text-neutral-400">
                    <MessageSquare size={12} />
                    {card.commentCount}
                  </span>
                )}

                {/* Linked note indicator */}
                {card.noteId && (
                  <span
                    className="flex items-center text-xs text-emerald-500 dark:text-emerald-400"
                    title={card.note?.title || t('kanban.card.linkedNote')}
                  >
                    <FileText size={12} />
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Move to column dropdown/overlay */}
      {showMoveMenu && canMove && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setShowMoveMenu(false)} />
          <div className={clsx(
            'z-40 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-800 shadow-xl py-1 overflow-hidden',
            isMobile
              ? 'fixed bottom-0 left-0 right-0 rounded-t-2xl rounded-b-none pb-[env(safe-area-inset-bottom)] border-b-0 shadow-2xl'
              : 'absolute mt-1 w-56 right-0'
          )}>
            <div className="px-3 py-2 text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide flex items-center gap-1.5">
              <ArrowRightLeft size={12} />
              {t('kanban.card.moveToColumn')}
            </div>
            <div className={clsx(isMobile && 'max-h-[40vh] overflow-y-auto')}>
              {otherColumns.map(col => (
                <button
                  key={col.id}
                  type="button"
                  onClick={() => handleMoveToColumn(col.id)}
                  className="flex items-center gap-2 w-full px-3 py-2.5 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 transition-colors min-h-[44px]"
                >
                  {col.isCompleted && <CheckCircle2 size={14} className="text-emerald-500 flex-shrink-0" />}
                  <span className="truncate">{translateColumnTitle(col.title)}</span>
                  <span className="ml-auto text-xs text-neutral-400 dark:text-neutral-500 flex-shrink-0">{col.cards.length}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
