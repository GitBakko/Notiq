import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ListChecks, Plus } from 'lucide-react';
import clsx from 'clsx';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import { useTaskLists } from '../../hooks/useTaskLists';
import { createTaskList, addTaskItem } from '../../features/tasks/taskListService';
import type { ListItemInfo } from './EditorContextMenu';
import type { Editor } from '@tiptap/react';

interface TransformToTaskListModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: ListItemInfo[];
  editor: Editor;
}

type Step = 'list' | 'review' | 'confirm-remove';

export default function TransformToTaskListModal({ isOpen, onClose, items, editor }: TransformToTaskListModalProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>('list');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [newListTitle, setNewListTitle] = useState('');
  const [selectedListId, setSelectedListId] = useState<string>('');
  const [selectedListTitle, setSelectedListTitle] = useState<string>('');
  const [itemChecklist, setItemChecklist] = useState<{ text: string; isDuplicate: boolean; checked: boolean }[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  const taskLists = useTaskLists();

  function handleClose() {
    setStep('list');
    setMode('existing');
    setNewListTitle('');
    setSelectedListId('');
    setSelectedListTitle('');
    setItemChecklist([]);
    setIsCreating(false);
    onClose();
  }

  function handleCheckDuplicates(listId: string, listTitle: string) {
    setSelectedListId(listId);
    setSelectedListTitle(listTitle);
    const list = taskLists?.find(l => l.id === listId);
    const existingTitles = new Set(
      (list?.items || []).map(i => i.text.trim().toLowerCase())
    );

    const checklist = items.map(item => {
      const isDuplicate = existingTitles.has(item.text.trim().toLowerCase());
      return { text: item.text, isDuplicate, checked: !isDuplicate };
    });

    const hasDuplicates = checklist.some(i => i.isDuplicate);
    if (hasDuplicates) {
      setItemChecklist(checklist);
      setStep('review');
    } else {
      handleAddItems(listId, listTitle, items);
    }
  }

  async function handleAddItems(listId: string, listTitle: string, itemsToAdd: ListItemInfo[]) {
    setIsCreating(true);
    try {
      for (const item of itemsToAdd) {
        await addTaskItem(listId, item.text, 'MEDIUM');
      }
      toast.success(t('editor.transform.taskListSuccess', { count: itemsToAdd.length, list: listTitle }));
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  async function handleNewListConfirm() {
    if (!newListTitle.trim()) return;
    setIsCreating(true);
    try {
      const list = await createTaskList(newListTitle.trim());
      for (const item of items) {
        await addTaskItem(list.id, item.text, 'MEDIUM');
      }
      toast.success(t('editor.transform.taskListSuccess', { count: items.length, list: newListTitle.trim() }));
      setStep('confirm-remove');
    } catch {
      toast.error(t('common.somethingWentWrong'));
    } finally {
      setIsCreating(false);
    }
  }

  function handleRemoveItems() {
    const sorted = [...items].sort((a, b) => b.from - a.from);
    const chain = editor.chain();
    for (const item of sorted) {
      chain.deleteRange({ from: item.from, to: item.to });
    }
    chain.run();
    handleClose();
    navigate('/tasks');
  }

  function handleKeepItems() {
    handleClose();
    navigate('/tasks');
  }

  const title = step === 'list'
    ? t('editor.transform.toTaskList')
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

      {/* Step: List Selection */}
      {step === 'list' && (
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
              {t('editor.transform.existingList')}
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
                {t('editor.transform.newList')}
              </span>
            </button>
          </div>

          {mode === 'existing' ? (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {!taskLists ? (
                <p className="text-sm text-neutral-500 dark:text-neutral-400">{t('common.loading')}</p>
              ) : taskLists.length > 0 ? (
                taskLists.map(list => (
                  <button
                    key={list.id}
                    onClick={() => handleCheckDuplicates(list.id, list.title)}
                    disabled={isCreating}
                    className="w-full flex items-center justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <ListChecks size={16} className="text-neutral-400" />
                      <span className="text-sm text-neutral-900 dark:text-white">{list.title}</span>
                    </span>
                    <span className="text-xs text-neutral-400">{list.items.length}</span>
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
                value={newListTitle}
                onChange={e => setNewListTitle(e.target.value)}
                placeholder={t('editor.transform.listTitle')}
                className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-white placeholder-neutral-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter') handleNewListConfirm();
                }}
              />
              <button
                onClick={handleNewListConfirm}
                disabled={!newListTitle.trim() || isCreating}
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
                if (selectedItems.length > 0) handleAddItems(selectedListId, selectedListTitle, selectedItems);
                else handleClose();
              }}
              disabled={isCreating}
              className="flex-1 py-2 px-4 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg transition-colors"
            >
              {isCreating ? t('common.loading') : t('editor.transform.addSelected')}
            </button>
            <button
              onClick={() => handleAddItems(selectedListId, selectedListTitle, items)}
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
