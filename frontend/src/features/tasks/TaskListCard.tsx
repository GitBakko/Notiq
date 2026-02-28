import { useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp, KanbanSquare, Share2, MoreVertical, Trash2, Users, Kanban } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
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
import ConvertTaskListToKanbanModal from './ConvertTaskListToKanbanModal';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import type { LocalTaskList, LocalTaskItem } from '../../lib/db';

interface TaskListCardProps {
  taskList: LocalTaskList & { items: LocalTaskItem[] };
  readOnly?: boolean;
  onShareClick?: (taskListId: string) => void;
  onViewShares?: (taskListId: string) => void;
}

export default function TaskListCard({ taskList, readOnly, onShareClick, onViewShares }: TaskListCardProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isExpanded, setIsExpanded] = useState(true);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState(taskList.title);
  const [newItemText, setNewItemText] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showConvertModal, setShowConvertModal] = useState(false);
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
    try {
      await taskListService.deleteTaskList(taskList.id);
      toast.success(t('taskLists.deleteList'));
    } catch (e) {
      console.error('Failed to delete list', e);
    }
  };


  return (
    <div className="rounded-xl border border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-800 shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-100/80 dark:border-neutral-700/50">
        <button onClick={() => setIsExpanded(!isExpanded)} className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300">
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
              className="w-full bg-transparent border-b-2 border-emerald-500 font-semibold text-neutral-900 dark:text-white outline-none"
              autoFocus
            />
          ) : (
            <h3
              onClick={() => !readOnly && setIsEditingTitle(true)}
              className={clsx(
                'font-semibold text-neutral-900 dark:text-white truncate transition-colors',
                !readOnly && 'cursor-pointer hover:text-emerald-600 dark:hover:text-emerald-400'
              )}
            >
              {taskList.title}
            </h3>
          )}
        </div>

        {/* Shared by badge (for received shared lists) */}
        {taskList.ownership === 'shared' && taskList.sharedByUser && (
          <span className="flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-700 px-2 py-0.5 rounded-full">
            <Users size={12} />
            {t('taskLists.sharedBy', { name: taskList.sharedByUser.name || taskList.sharedByUser.email })}
          </span>
        )}

        {/* Active collaborators badge (for own lists) */}
        {taskList.ownership !== 'shared' && taskList.sharedWith && taskList.sharedWith.filter(s => s.status === 'ACCEPTED').length > 0 && (
          <button
            onClick={() => onViewShares?.(taskList.id)}
            className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/30 px-2 py-0.5 rounded-full hover:bg-emerald-100 dark:hover:bg-emerald-900/50 transition-colors"
            title={taskList.sharedWith.filter(s => s.status === 'ACCEPTED').map(s => s.user.name || s.user.email).join(', ')}
          >
            <Users size={12} />
            {taskList.sharedWith.filter(s => s.status === 'ACCEPTED').length}
          </button>
        )}

        {/* Linked Kanban board */}
        {taskList.kanbanBoard && (
          <button
            onClick={() => navigate(`/kanban/${taskList.kanbanBoard!.id}`)}
            className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 rounded-full hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors"
            title={taskList.kanbanBoard.title}
          >
            <KanbanSquare size={12} />
          </button>
        )}

        {/* Progress */}
        <span className="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap">
          {t('taskLists.progress', { done: doneCount, total: totalCount })}
        </span>

        {/* Share button */}
        {!readOnly && taskList.ownership !== 'shared' && onShareClick && (
          <button
            onClick={() => onShareClick(taskList.id)}
            className="text-neutral-400 hover:text-emerald-600 dark:hover:text-emerald-400 transition-colors"
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
              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <MoreVertical size={16} />
            </button>
            {showMenu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setShowMenu(false)} />
                <div className="absolute right-0 top-8 z-20 w-48 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 bg-white dark:bg-neutral-800 shadow-lg py-1">
                  <button
                    onClick={() => { setShowMenu(false); setShowConvertModal(true); }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700"
                  >
                    <Kanban size={14} />
                    {t('taskLists.convertToKanban')}
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); setShowDeleteConfirm(true); }}
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
        <div className="divide-y divide-neutral-50 dark:divide-neutral-700/30">
          {sortedItems.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-neutral-400 dark:text-neutral-400 italic">
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
                className="w-full bg-transparent text-sm text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-400 outline-none"
              />
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={handleDeleteList}
        title={t('taskLists.deleteList')}
        message={t('taskLists.deleteListConfirm')}
        confirmText={t('common.delete')}
        variant="danger"
      />

      <ConvertTaskListToKanbanModal
        isOpen={showConvertModal}
        onClose={() => setShowConvertModal(false)}
        taskList={taskList as LocalTaskList & { items: LocalTaskItem[] }}
      />
    </div>
  );
}
