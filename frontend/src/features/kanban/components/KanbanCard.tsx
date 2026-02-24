import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import clsx from 'clsx';
import { formatDistanceToNow, isToday, isPast, startOfDay } from 'date-fns';
import { it as itLocale, enUS } from 'date-fns/locale';
import { GripVertical, MessageSquare, FileText, Calendar } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { KanbanCard as KanbanCardType } from '../types';

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
        'rounded-lg bg-white dark:bg-gray-800 p-3 shadow-sm',
        'border border-gray-200 dark:border-gray-700',
        'hover:shadow-md transition-all cursor-pointer',
        isDragging && 'opacity-50 shadow-lg z-50',
        isHighlighted && 'ring-2 ring-emerald-400 dark:ring-emerald-500 animate-pulse shadow-md shadow-emerald-100 dark:shadow-emerald-900/30'
      )}
    >
      <div className="flex items-start gap-2">
        {/* Drag handle */}
        {!readOnly && (
          <div
            data-dnd-handle
            {...attributes}
            {...listeners}
            className="mt-0.5 flex-shrink-0 cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 touch-none"
          >
            <GripVertical size={16} />
          </div>
        )}

        {/* Card body */}
        <div
          className="flex-1 min-w-0"
          onClick={() => onSelect(card.id)}
        >
          {/* Title */}
          <p className="text-sm font-medium text-gray-900 dark:text-white line-clamp-2">
            {card.title || t('kanban.card.untitled')}
          </p>

          {/* Metadata row — only rendered when there's data to show */}
          {(card.assignee || card.dueDate || card.commentCount > 0 || card.noteId) && (
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              {/* Assignee */}
              {card.assignee && (
                <span
                  className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400"
                  title={card.assignee.name || card.assignee.email}
                >
                  <span
                    className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
                    style={{ backgroundColor: card.assignee.color || '#6b7280' }}
                  >
                    {(card.assignee.name || card.assignee.email).charAt(0).toUpperCase()}
                  </span>
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
                    dueDateStatus === 'default' && 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                  )}
                >
                  <Calendar size={12} />
                  {formatDistanceToNow(new Date(card.dueDate), { addSuffix: true, locale: dateLocale })}
                </span>
              )}

              {/* Comment count */}
              {card.commentCount > 0 && (
                <span className="flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
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
