import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { LayoutDashboard, Plus, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import Modal from '../../components/ui/Modal';
import { useKanbanBoards } from '../kanban/hooks/useKanbanBoards';
import { useKanbanBoard } from '../kanban/hooks/useKanbanBoard';
import { useKanbanMutations } from '../kanban/hooks/useKanbanMutations';
import { createBoardFromTaskList } from '../kanban/kanbanService';
import { syncPush } from '../sync/syncService';
import * as taskListService from './taskListService';
import type { LocalTaskList, LocalTaskItem } from '../../lib/db';

interface ConvertTaskListToKanbanModalProps {
  isOpen: boolean;
  onClose: () => void;
  taskList: LocalTaskList & { items: LocalTaskItem[] };
}

interface ChecklistItem {
  text: string;
  isChecked: boolean;
  isDuplicate: boolean;
  selected: boolean;
}

type Step = 'board' | 'review' | 'confirm-remove';

export default function ConvertTaskListToKanbanModal({ isOpen, onClose, taskList }: ConvertTaskListToKanbanModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>('board');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [itemChecklist, setItemChecklist] = useState<ChecklistItem[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [convertedBoardId, setConvertedBoardId] = useState<string | null>(null);
  const [pendingBoardId, setPendingBoardId] = useState<string>('');

  const { data: boards, isLoading: boardsLoading } = useKanbanBoards();
  const { data: boardDetail } = useKanbanBoard(selectedBoardId || undefined);
  const { createCard } = useKanbanMutations(selectedBoardId || undefined);

  const taskItems = taskList.items || [];

  // When boardDetail loads for a pending board selection, run duplicate check
  useEffect(() => {
    if (pendingBoardId && boardDetail && boardDetail.id === pendingBoardId) {
      setPendingBoardId('');
      runDuplicateCheck();
    }
  }, [boardDetail, pendingBoardId]);

  function handleClose() {
    setStep('board');
    setMode('existing');
    setSelectedBoardId('');
    setPendingBoardId('');
    setItemChecklist([]);
    setIsCreating(false);
    setConvertedBoardId(null);
    onClose();
  }

  function handleSelectExistingBoard(boardId: string) {
    setSelectedBoardId(boardId);
    setPendingBoardId(boardId);
  }

  function runDuplicateCheck() {
    if (!boardDetail) return;

    const columns = boardDetail.columns;
    // Collect all existing card titles across all columns
    const existingTitles = new Set(
      columns.flatMap(col => (col.cards || []).map(c => c.title.trim().toLowerCase()))
    );

    const checklist: ChecklistItem[] = taskItems.map(item => {
      const isDuplicate = existingTitles.has(item.text.trim().toLowerCase());
      return { text: item.text, isChecked: !!item.isChecked, isDuplicate, selected: !isDuplicate };
    });

    const hasDuplicates = checklist.some(i => i.isDuplicate);
    if (hasDuplicates) {
      setItemChecklist(checklist);
      setStep('review');
    } else {
      distributeCards(taskItems.map(i => ({ text: i.text, isChecked: !!i.isChecked })));
    }
  }

  async function distributeCards(items: { text: string; isChecked: boolean }[]) {
    if (!boardDetail || boardDetail.columns.length === 0) return;

    setIsCreating(true);
    try {
      const columns = boardDetail.columns;
      const todoColumnId = columns[0].id;
      const doneColumnId = columns[columns.length - 1].id;

      for (const item of items) {
        const columnId = item.isChecked ? doneColumnId : todoColumnId;
        await createCard.mutateAsync({ columnId, title: item.text });
      }

      toast.success(t('editor.transform.kanbanSuccess', { count: items.length, board: boardDetail.title }));
      setConvertedBoardId(selectedBoardId);
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleNewBoardConvert() {
    setIsCreating(true);
    try {
      await syncPush();
      const board = await createBoardFromTaskList(taskList.id);
      queryClient.invalidateQueries({ queryKey: ['kanban-boards'] });
      toast.success(t('taskLists.convertedToKanban'));
      setConvertedBoardId(board.id);
      setStep('confirm-remove');
    } catch {
      toast.error(t('taskLists.convertToKanbanFailed'));
    } finally {
      setIsCreating(false);
    }
  }

  function handleKeepAndNavigate() {
    const boardId = convertedBoardId;
    handleClose();
    if (boardId) navigate(`/kanban?boardId=${boardId}`);
  }

  async function handleRemoveAndNavigate() {
    const boardId = convertedBoardId;
    try {
      await taskListService.deleteTaskList(taskList.id);
    } catch (e) {
      console.error('Failed to delete task list', e);
    }
    handleClose();
    if (boardId) navigate(`/kanban?boardId=${boardId}`);
  }

  const title = step === 'board'
    ? t('taskLists.convertToKanban')
    : step === 'review'
    ? t('editor.transform.duplicatesFound', { count: itemChecklist.filter(i => i.isDuplicate).length })
    : t('taskLists.keepOrRemoveTitle');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      {/* Items preview */}
      {step === 'board' && (
        <div className="mb-4 p-3 bg-neutral-50 dark:bg-neutral-900 rounded-lg max-h-32 overflow-y-auto">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
            {t('editor.transform.itemsSelected', { count: taskItems.length })}
          </p>
          <ul className="space-y-1">
            {taskItems.map((item, i) => (
              <li key={i} className="text-sm text-neutral-700 dark:text-neutral-300 truncate flex items-center gap-2">
                <span className={clsx(
                  'w-3 h-3 rounded-sm border flex-shrink-0',
                  item.isChecked
                    ? 'bg-emerald-500 border-emerald-500'
                    : 'border-neutral-300 dark:border-neutral-600'
                )} />
                <span className={item.isChecked ? 'line-through text-neutral-400' : ''}>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Step: Board Selection */}
      {step === 'board' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <button
              onClick={() => setMode('existing')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'existing'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-neutral-200/60 dark:border-neutral-700/40 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
              }`}
            >
              {t('editor.transform.existingBoard')}
            </button>
            <button
              onClick={() => setMode('new')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'new'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-neutral-200/60 dark:border-neutral-700/40 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
              }`}
            >
              <span className="flex items-center justify-center gap-1">
                <Plus size={14} />
                {t('editor.transform.newBoard')}
              </span>
            </button>
          </div>

          {mode === 'existing' ? (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {boardsLoading ? (
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.loading')}</p>
              ) : boards && boards.length > 0 ? (
                boards.map(board => (
                  <button
                    key={board.id}
                    disabled={!!pendingBoardId}
                    onClick={() => handleSelectExistingBoard(board.id)}
                    className="w-full flex items-center justify-between p-3 rounded-lg border border-neutral-200/60 dark:border-neutral-700/40 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <LayoutDashboard size={16} className="text-neutral-400" />
                      <span className="text-sm text-neutral-900 dark:text-white">{board.title}</span>
                    </span>
                    {pendingBoardId === board.id ? (
                      <span className="text-xs text-neutral-400">{t('common.loading')}</span>
                    ) : (
                      <ChevronRight size={16} className="text-neutral-400" />
                    )}
                  </button>
                ))
              ) : (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 text-center py-4">
                  {t('kanban.noBoards')}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-neutral-600 dark:text-neutral-300">
                {t('taskLists.convertToKanbanConfirm')}
              </p>
              <button
                onClick={handleNewBoardConvert}
                disabled={isCreating}
                className="w-full py-2 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {isCreating ? t('common.loading') : t('editor.transform.confirm')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step: Review Duplicates */}
      {step === 'review' && (
        <div className="space-y-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {t('editor.transform.duplicatesFound', { count: itemChecklist.filter(i => i.isDuplicate).length })}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {t('editor.transform.duplicatesFoundSub')}
          </p>
          <div className="max-h-60 overflow-y-auto space-y-1">
            {itemChecklist.map((item, i) => (
              <label key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={item.selected}
                  onChange={() => {
                    const updated = [...itemChecklist];
                    updated[i] = { ...updated[i], selected: !updated[i].selected };
                    setItemChecklist(updated);
                  }}
                  className="rounded border-neutral-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span className="flex-1 text-sm text-neutral-900 dark:text-white truncate">{item.text}</span>
                <span className={clsx(
                  "text-xs px-2 py-0.5 rounded-full font-medium",
                  item.isDuplicate
                    ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                )}>
                  {item.isDuplicate ? t('editor.transform.statusDuplicate') : t('editor.transform.statusNew')}
                </span>
              </label>
            ))}
          </div>
          <div className="flex gap-3 pt-2">
            <button
              onClick={() => {
                const selected = itemChecklist
                  .filter(i => i.selected)
                  .map(i => ({ text: i.text, isChecked: i.isChecked }));
                if (selected.length > 0) distributeCards(selected);
                else handleClose();
              }}
              disabled={isCreating}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              {isCreating ? t('common.loading') : t('editor.transform.addSelected')}
            </button>
            <button
              onClick={() => distributeCards(itemChecklist.map(i => ({ text: i.text, isChecked: i.isChecked })))}
              disabled={isCreating}
              className="flex-1 py-2 px-4 text-sm border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50"
            >
              {t('editor.transform.addAll')}
            </button>
          </div>
        </div>
      )}

      {/* Step: Confirm Remove */}
      {step === 'confirm-remove' && (
        <div className="space-y-4">
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {t('taskLists.keepOrRemoveMessage')}
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleKeepAndNavigate}
              className="flex-1 py-2 px-4 text-sm border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
            >
              {t('taskLists.keepTaskList')}
            </button>
            <button
              onClick={handleRemoveAndNavigate}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              {t('taskLists.removeTaskList')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
