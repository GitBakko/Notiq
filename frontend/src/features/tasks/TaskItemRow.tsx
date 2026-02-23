import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2, GripVertical, Calendar } from 'lucide-react';
import clsx from 'clsx';
import TaskPriorityBadge from './TaskPriorityBadge';
import type { LocalTaskItem } from '../../lib/db';

interface TaskItemRowProps {
  item: LocalTaskItem;
  readOnly?: boolean;
  onToggle: (id: string) => void;
  onUpdate: (id: string, data: Partial<Pick<LocalTaskItem, 'text' | 'priority' | 'dueDate'>>) => void;
  onDelete: (id: string) => void;
  dragHandleProps?: Record<string, unknown>;
}

export default function TaskItemRow({ item, readOnly, onToggle, onUpdate, onDelete, dragHandleProps }: TaskItemRowProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(item.text);
  const inputRef = useRef<HTMLInputElement>(null);

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

  return (
    <div className={clsx(
      'group flex items-center gap-2 px-3 py-2 rounded-lg transition-colors',
      'hover:bg-gray-50 dark:hover:bg-gray-800/50',
      item.isChecked && 'opacity-60'
    )}>
      {/* Drag handle */}
      {!readOnly && (
        <div
          data-dnd-handle
          {...(dragHandleProps || {})}
          className="cursor-grab text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400"
        >
          <GripVertical size={16} />
        </div>
      )}

      {/* Checkbox */}
      <input
        type="checkbox"
        checked={item.isChecked}
        onChange={() => !readOnly && onToggle(item.id)}
        disabled={readOnly}
        className="h-4 w-4 rounded border-gray-300 text-emerald-600 focus:ring-emerald-500 dark:border-gray-600 dark:bg-gray-800"
      />

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
