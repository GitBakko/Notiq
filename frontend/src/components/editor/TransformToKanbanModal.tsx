import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { LayoutDashboard, Plus, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import { useKanbanBoards } from '../../features/kanban/hooks/useKanbanBoards';
import { useKanbanBoard } from '../../features/kanban/hooks/useKanbanBoard';
import { useKanbanMutations } from '../../features/kanban/hooks/useKanbanMutations';
import type { ListItemInfo } from './EditorContextMenu';
import type { Editor } from '@tiptap/react';

interface TransformToKanbanModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ListItemInfo[];
  editor: Editor;
}

type Step = 'board' | 'column' | 'review' | 'confirm-remove';

export default function TransformToKanbanModal({ isOpen, onClose, items, editor }: TransformToKanbanModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('board');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [selectedBoardId, setSelectedBoardId] = useState<string>('');
  const [newBoardTitle, setNewBoardTitle] = useState('');
  const [selectedColumnId, setSelectedColumnId] = useState<string>('');
  const [itemChecklist, setItemChecklist] = useState<{ text: string; isDuplicate: boolean; checked: boolean }[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  const { data: boards, isLoading: boardsLoading } = useKanbanBoards();
  const { data: boardDetail } = useKanbanBoard(selectedBoardId || undefined);
  const { createBoard, createCard } = useKanbanMutations(selectedBoardId || undefined);

  function handleClose() {
    setStep('board');
    setMode('existing');
    setSelectedBoardId('');
    setNewBoardTitle('');
    setSelectedColumnId('');
    setItemChecklist([]);
    setIsCreating(false);
    onClose();
  }

  function handleCheckDuplicates(columnId: string) {
    setSelectedColumnId(columnId);
    const column = boardDetail?.columns.find(c => c.id === columnId);
    const existingTitles = new Set(
      (column?.cards || []).map(c => c.title.trim().toLowerCase())
    );

    const checklist = items.map(item => {
      const title = item.text.split('\n')[0].trim().toLowerCase();
      const isDuplicate = existingTitles.has(title);
      return { text: item.text, isDuplicate, checked: !isDuplicate };
    });

    const hasDuplicates = checklist.some(i => i.isDuplicate);
    if (hasDuplicates) {
      setItemChecklist(checklist);
      setStep('review');
    } else {
      handleCreateCards(columnId, items);
    }
  }

  async function handleCreateCards(columnId: string, itemsToAdd: ListItemInfo[]) {
    setIsCreating(true);
    try {
      const boardTitle = boardDetail?.title || '';
      for (const item of itemsToAdd) {
        const lines = item.text.split('\n');
        const title = lines[0];
        const description = lines.length > 1 ? item.text : undefined;
        await createCard.mutateAsync({ columnId, title, description });
      }
      toast.success(t('editor.transform.kanbanSuccess', { count: itemsToAdd.length, board: boardTitle }));
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleNewBoardConfirm() {
    if (!newBoardTitle.trim()) return;
    setIsCreating(true);
    try {
      const board = await createBoard.mutateAsync({ title: newBoardTitle.trim() });
      setSelectedBoardId(board.id);
      setStep('column');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  function handleRemoveItems() {
    const boardId = selectedBoardId;
    // Delete in reverse order to preserve positions
    const sorted = [...items].sort((a, b) => b.from - a.from);
    const chain = editor.chain();
    for (const item of sorted) {
      chain.deleteRange({ from: item.from, to: item.to });
    }
    chain.run();
    handleClose();
    if (boardId) navigate(`/kanban?boardId=${boardId}`);
  }

  function handleKeepItems() {
    const boardId = selectedBoardId;
    handleClose();
    if (boardId) navigate(`/kanban?boardId=${boardId}`);
  }

  const title = step === 'board'
    ? t('editor.transform.toKanban')
    : step === 'column'
    ? t('editor.transform.selectColumn')
    : step === 'review'
    ? t('editor.transform.duplicatesFound', { count: itemChecklist.filter(i => i.isDuplicate).length })
    : t('editor.transform.removeFromNote');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      {/* Items preview */}
      {step !== 'confirm-remove' && step !== 'review' && (
        <div className="mb-4 p-3 bg-neutral-50 dark:bg-neutral-900 rounded-lg max-h-32 overflow-y-auto">
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-2">
            {t('editor.transform.itemsSelected', { count: items.length })}
          </p>
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li key={i} className="text-sm text-neutral-700 dark:text-neutral-300 truncate">
                • {item.text}
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
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
              }`}
            >
              {t('editor.transform.existingBoard')}
            </button>
            <button
              onClick={() => setMode('new')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'new'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
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
                    onClick={() => {
                      setSelectedBoardId(board.id);
                      setStep('column');
                    }}
                    className="w-full flex items-center justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors text-left"
                  >
                    <span className="flex items-center gap-2">
                      <LayoutDashboard size={16} className="text-neutral-400" />
                      <span className="text-sm text-neutral-900 dark:text-white">{board.title}</span>
                    </span>
                    <ChevronRight size={16} className="text-neutral-400" />
                  </button>
                ))
              ) : (
                <p className="text-sm text-neutral-500 dark:text-neutral-400 text-center py-4">
                  {t('common.noResults', { query: '' })}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                value={newBoardTitle}
                onChange={e => setNewBoardTitle(e.target.value)}
                placeholder={t('editor.transform.boardTitle')}
                className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleNewBoardConfirm();
                }}
              />
              <button
                onClick={handleNewBoardConfirm}
                disabled={!newBoardTitle.trim() || isCreating}
                className="w-full py-2 px-4 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {isCreating ? t('common.loading') : t('editor.transform.confirm')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step: Column Selection */}
      {step === 'column' && (
        <div className="space-y-2">
          {boardDetail?.columns.map(col => (
            <button
              key={col.id}
              onClick={() => handleCheckDuplicates(col.id)}
              disabled={isCreating}
              className="w-full flex items-center justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors text-left disabled:opacity-50"
            >
              <span className="text-sm text-neutral-900 dark:text-white">
                {t(`kanban.column.${col.title === 'TODO' ? 'todo' : col.title === 'IN_PROGRESS' ? 'inProgress' : col.title === 'DONE' ? 'done' : 'custom'}`, { defaultValue: col.title })}
              </span>
              <span className="text-xs text-neutral-400">{col.cards.length}</span>
            </button>
          ))}
          <button
            onClick={() => {
              setSelectedBoardId('');
              setStep('board');
            }}
            className="w-full py-2 text-sm text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
          >
            {t('common.back')}
          </button>
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
                  checked={item.checked}
                  onChange={() => {
                    const updated = [...itemChecklist];
                    updated[i] = { ...updated[i], checked: !updated[i].checked };
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
                const selectedItems = items.filter((_, i) => itemChecklist[i].checked);
                if (selectedItems.length > 0) handleCreateCards(selectedColumnId, selectedItems);
                else handleClose();
              }}
              disabled={isCreating}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              {isCreating ? t('common.loading') : t('editor.transform.addSelected')}
            </button>
            <button
              onClick={() => handleCreateCards(selectedColumnId, items)}
              disabled={isCreating}
              className="flex-1 py-2 px-4 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors disabled:opacity-50"
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
            {t('editor.transform.removeFromNote')}
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleKeepItems}
              className="flex-1 py-2 px-4 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
            >
              {t('editor.transform.keepItems')}
            </button>
            <button
              onClick={handleRemoveItems}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors"
            >
              {t('editor.transform.removeItems')}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
