import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, GripVertical, Calendar, Circle, CheckCircle2 } from 'lucide-react';
import clsx from 'clsx';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import TaskPriorityBadge from './TaskPriorityBadge';
import { useAuthStore } from '../../store/authStore';
import type { LocalTaskItem } from '../../lib/db';

interface TaskItemRowProps {
  item: LocalTaskItem;
  readOnly?: boolean;
  onToggle: (id: string) => void;
  onUpdate: (id: string, data: Partial<Pick<LocalTaskItem, 'text' | 'priority' | 'dueDate'>>) => void;
  onDelete: (id: string) => void;
}

export default function TaskItemRow({ item, readOnly, onToggle, onUpdate, onDelete }: TaskItemRowProps) {
  const { t } = useTranslation();
  const currentUserId = useAuthStore((s) => s.user?.id);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id, disabled: readOnly });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  };

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Keep local edit text in sync with prop changes
  useEffect(() => {
    if (!isEditing) {
      setEditText(item.text);
    }
  }, [item.text, isEditing]);

  const handleSaveText = () => {
    setIsEditing(false);
    if (editText.trim() && editText.trim() !== item.text) {
      onUpdate(item.id, { text: editText.trim() });
    } else {
      setEditText(item.text);
    }
  };

  const cyclePriority = () => {
    if (readOnly) return;
    const order: ('LOW' | 'MEDIUM' | 'HIGH')[] = ['LOW', 'MEDIUM', 'HIGH'];
    const idx = order.indexOf(item.priority);
    const next = order[(idx + 1) % order.length];
    onUpdate(item.id, { priority: next });
  };

  // Only the user who checked the item can uncheck it
  const canUncheck = !item.isChecked || !item.checkedByUser || item.checkedByUser.id === currentUserId;
  const checkDisabled = readOnly || (item.isChecked && !canUncheck);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={clsx(
        'group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors',
        'hover:bg-gray-50 dark:hover:bg-gray-800/50',
        item.isChecked && 'opacity-60',
        isDragging && 'z-50 shadow-lg bg-white dark:bg-gray-800'
      )}
    >
      {/* Drag handle */}
      {!readOnly && (
        <div
          data-dnd-handle
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 touch-none"
        >
          <GripVertical size={16} />
        </div>
      )}

      {/* Checkbox */}
      <button
        type="button"
        onClick={() => !checkDisabled && onToggle(item.id)}
        disabled={checkDisabled}
        className={clsx(
          'flex-shrink-0 transition-all duration-200 ease-in-out',
          checkDisabled ? 'cursor-default' : 'cursor-pointer',
          item.isChecked
            ? canUncheck
              ? 'text-emerald-500 dark:text-emerald-400 scale-110'
              : 'text-emerald-500/50 dark:text-emerald-400/50 scale-110'
            : 'text-gray-300 dark:text-gray-600 hover:text-emerald-400 dark:hover:text-emerald-500'
        )}
        aria-checked={item.isChecked}
        role="checkbox"
        title={checkDisabled && !readOnly ? t('taskLists.onlyCheckerCanUncheck') : undefined}
      >
        {item.isChecked ? (
          <CheckCircle2 size={20} strokeWidth={2.5} />
        ) : (
          <Circle size={20} strokeWidth={1.5} />
        )}
      </button>

      {/* Text */}
      <div className="flex-1 min-w-0">
        {isEditing && !readOnly ? (
          <input
            ref={inputRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onBlur={handleSaveText}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveText();
              if (e.key === 'Escape') { setIsEditing(false); setEditText(item.text); }
            }}
            className="w-full bg-transparent border-b border-emerald-500 text-sm text-gray-900 dark:text-white outline-none py-0.5"
          />
        ) : (
          <span
            onClick={() => !readOnly && setIsEditing(true)}
            className={clsx(
              'text-sm cursor-pointer truncate block',
              item.isChecked
                ? 'line-through text-gray-400 dark:text-gray-500'
                : 'text-gray-900 dark:text-white'
            )}
          >
            {item.text}
          </span>
        )}
      </div>

      {/* Checked by indicator (only if checked by someone else) */}
      {item.isChecked && item.checkedByUser && item.checkedByUser.id !== currentUserId && (
        <span
          className="flex-shrink-0 flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500"
          title={item.checkedByUser.name || item.checkedByUser.email}
        >
          <span
            className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0"
            style={{ backgroundColor: item.checkedByUser.color || '#6b7280' }}
          >
            {(item.checkedByUser.name || item.checkedByUser.email).charAt(0).toUpperCase()}
          </span>
          <span className="hidden sm:inline truncate max-w-[80px]">
            {item.checkedByUser.name || item.checkedByUser.email.split('@')[0]}
          </span>
        </span>
      )}

      {/* Priority badge — click to cycle */}
      <button onClick={cyclePriority} disabled={readOnly} className="flex-shrink-0">
        <TaskPriorityBadge priority={item.priority} />
      </button>

      {/* Due date */}
      {item.dueDate ? (
        <div className="flex-shrink-0 flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 relative">
          <Calendar size={12} />
          <span>{new Date(item.dueDate).toLocaleDateString()}</span>
          {!readOnly && (
            <input
              type="date"
              value={item.dueDate.split('T')[0]}
              onChange={(e) => onUpdate(item.id, { dueDate: e.target.value ? new Date(e.target.value).toISOString() : null })}
              className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
            />
          )}
        </div>
      ) : !readOnly ? (
        <label className="flex-shrink-0 cursor-pointer text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity relative">
          <Calendar size={14} />
          <input
            type="date"
            onChange={(e) => {
              if (e.target.value) onUpdate(item.id, { dueDate: new Date(e.target.value).toISOString() });
            }}
            className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
          />
        </label>
      ) : null}

      {/* Delete button */}
      {!readOnly && (
        <button
          onClick={() => onDelete(item.id)}
          className="flex-shrink-0 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
          title={t('taskLists.deleteItem')}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
}
