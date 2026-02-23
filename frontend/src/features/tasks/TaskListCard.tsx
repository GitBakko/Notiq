import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, Share2, MoreVertical, Trash2, Users } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import TaskItemRow from './TaskItemRow';
import * as taskListService from './taskListService';
import type { LocalTaskList, LocalTaskItem } from '../../lib/db';

interface TaskListCardProps {
  taskList: LocalTaskList & { items: LocalTaskItem[] };
  readOnly?: boolean;
  onShareClick?: (taskListId: string) => void;
}

export default function TaskListCard({ taskList, readOnly, onShareClick }: TaskListCardProps) {
  const { t } = useTranslation();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(taskList.title);
  const [newItemText, setNewItemText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const newItemInputRef = useRef<HTMLInputElement>(null);

  const items = taskList.items || [];
  const sortedItems = [...items].sort((a, b) => a.position - b.position);
  const doneCount = items.filter(i => i.isChecked).length;
  const totalCount = items.length;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = sortedItems.findIndex(i => i.id === active.id);
    const newIndex = sortedItems.findIndex(i => i.id === over.id);

    if (oldIndex === -1 || newIndex === -1) return;

    // Create new order
    const reordered = [...sortedItems];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);

    // Update positions
    const updates = reordered.map((item, index) => ({
      id: item.id,
      position: index,
    }));

    await taskListService.reorderTaskItems(updates);
  };

  const handleSaveTitle = () => {
    setIsEditingTitle(false);
    if (editTitle.trim() && editTitle.trim() !== taskList.title) {
      taskListService.updateTaskList(taskList.id, { title: editTitle.trim() });
    } else {
      setEditTitle(taskList.title);
    }
  };

  const handleAddItem = async () => {
    if (!newItemText.trim()) return;
    try {
      await taskListService.addTaskItem(taskList.id, newItemText.trim());
      setNewItemText('');
      newItemInputRef.current?.focus();
    } catch (e) {
      console.error('Failed to add item', e);
    }
  };

  const handleToggle = async (itemId: string) => {
    const item = items.find(i => i.id === itemId);
    if (!item) return;
    await taskListService.updateTaskItem(itemId, { isChecked: !item.isChecked });
  };

  const handleUpdateItem = async (itemId: string, data: Partial<Pick<LocalTaskItem, 'text' | 'priority' | 'dueDate'>>) => {
    await taskListService.updateTaskItem(itemId, data);
  };

  const handleDeleteItem = async (itemId: string) => {
    await taskListService.deleteTaskItem(itemId);
  };

  const handleDeleteList = async () => {
    if (!confirm(t('taskLists.deleteListConfirm'))) return;
    try {
      await taskListService.deleteTaskList(taskList.id);
      toast.success(t('taskLists.deleteList'));
    } catch (e) {
      console.error('Failed to delete list', e);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-700/50">
        <button onClick={() => setIsExpanded(!isExpanded)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300">
          {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>

        <div className="flex-1 min-w-0">
          {isEditingTitle && !readOnly ? (
            <input
              ref={titleInputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSaveTitle();
                if (e.key === 'Escape') { setIsEditingTitle(false); setEditTitle(taskList.title); }
              }}
              className="w-full bg-transparent border-b-2 border-emerald-500 font-semibold text-gray-900 dark:text-white outline-none"
              autoFocus
            />
          ) : (
            <h3
              onClick={() => !readOnly && setIsEditingTitle(true)}
              className={clsx(
                'font-semibold text-gray-900 dark:text-white truncate transition-colors',
                !readOnly && 'cursor-pointer hover:text-emerald-600 dark:hover:text-emerald-400'
              )}
            >
              {taskList.title}
            </h3>
          )}
        </div>

        {/* Shared by badge */}
        {taskList.ownership === 'shared' && taskList.sharedByUser && (
          <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-full">
            <Users size={12} />
            {t('taskLists.sharedBy', { name: taskList.sharedByUser.name || taskList.sharedByUser.email })}
          </span>
        )}

        {/* Progress */}
        <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
          {t('taskLists.progress', { done: doneCount, total: totalCount })}
        </span>

        {/* Share button */}
        {!readOnly && taskList.ownership !== 'shared' && onShareClick && (
          <button
            onClick={() => onShareClick(taskList.id)}
            className="text-gray-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
            title={t('taskLists.share')}
          >
            <Share2 size={16} />
          </button>
        )}

        {/* Menu */}
        {!readOnly && taskList.ownership !== 'shared' && (
          <div className="relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <MoreVertical size={16} />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-8 z-20 w-48 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1">
                  <button
                    onClick={() => { setShowMenu(false); handleDeleteList(); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                  >
                    <Trash2 size={14} />
                    {t('taskLists.deleteList')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      {isExpanded && (
        <div className="divide-y divide-gray-50 dark:divide-gray-700/30">
          {sortedItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-gray-400 dark:text-gray-500 italic">
              {t('taskLists.emptyList')}
            </p>
          ) : readOnly ? (
            sortedItems.map(item => (
              <TaskItemRow
                key={item.id}
                item={item}
                readOnly
                onToggle={handleToggle}
                onUpdate={handleUpdateItem}
                onDelete={handleDeleteItem}
              />
            ))
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sortedItems.map(i => i.id)} strategy={verticalListSortingStrategy}>
                {sortedItems.map(item => (
                  <TaskItemRow
                    key={item.id}
                    item={item}
                    onToggle={handleToggle}
                    onUpdate={handleUpdateItem}
                    onDelete={handleDeleteItem}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}

          {/* Add item input */}
          {!readOnly && (
            <div className="px-4 py-3">
              <input
                ref={newItemInputRef}
                value={newItemText}
                onChange={(e) => setNewItemText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddItem();
                }}
                placeholder={t('taskLists.addItem')}
                className="w-full bg-transparent text-sm text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 outline-none"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
