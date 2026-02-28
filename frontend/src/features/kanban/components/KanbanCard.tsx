import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { formatDistanceToNow, isToday, isPast, startOfDay } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { MessageSquare, FileText, Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KanbanCard as KanbanCardType } from '../types';
import { PRIORITY_CONFIG } from '../../../utils/priorityConfig';

interface KanbanCardProps {
  card: KanbanCardType;
  onSelect: (cardId: string) => void;
  readOnly?: boolean;
  isHighlighted?: boolean;
}

function getDueDateStatus(dueDate: string): 'default' | 'today' | 'overdue' {
  const due = startOfDay(new Date(dueDate));
  if (isToday(due)) return 'today';
  if (isPast(due)) return 'overdue';
  return 'default';
}

export default function KanbanCard({ card, onSelect, readOnly, isHighlighted }: KanbanCardProps) {
  const { t, i18n } = useTranslation();
  const dateLocale = i18n.language.startsWith('it') ? itLocale : enUS;

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

  return (
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
          onClick={() => onSelect(card.id)}
        >
          {/* Title */}
          <p className="text-sm font-medium text-neutral-900 dark:text-white line-clamp-2">
            {card.title || t('kanban.card.untitled')}
          </p>

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
                    dueDateStatus === 'overdue' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                    dueDateStatus === 'today' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                    dueDateStatus === 'default' && 'bg-neutral-100 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-400'
                  )}
                >
                  <Calendar size={12} />
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
  );
}
