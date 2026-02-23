import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Plus } from 'lucide-react';
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

type Step = 'list' | 'confirm-remove';

export default function TransformToTaskListModal({ isOpen, onClose, items, editor }: TransformToTaskListModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('list');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [newListTitle, setNewListTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const taskLists = useTaskLists();

  function handleClose() {
    setStep('list');
    setMode('existing');
    setNewListTitle('');
    setIsCreating(false);
    onClose();
  }

  async function handleSelectList(listId: string, listTitle: string) {
    setIsCreating(true);
    try {
      for (const item of items) {
        await addTaskItem(listId, item.text, 'MEDIUM');
      }
      toast.success(t('editor.transform.taskListSuccess', { count: items.length, list: listTitle }));
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
  }

  function handleKeepItems() {
    handleClose();
  }

  const title = step === 'list'
    ? t('editor.transform.toTaskList')
    : t('editor.transform.removeFromNote');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={title} size="md">
      {/* Items preview */}
      {step !== 'confirm-remove' && (
        <div className="mb-4 p-3 bg-gray-50 dark:bg-gray-900 rounded-lg max-h-32 overflow-y-auto">
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
            {t('editor.transform.itemsSelected', { count: items.length })}
          </p>
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li key={i} className="text-sm text-gray-700 dark:text-gray-300 truncate">
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
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {t('editor.transform.existingList')}
            </button>
            <button
              onClick={() => setMode('new')}
              className={`flex-1 py-2 px-3 text-sm rounded-lg border transition-colors ${
                mode === 'new'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                  : 'border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700'
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
                <p className="text-sm text-gray-500 dark:text-gray-400">{t('common.loading')}</p>
              ) : taskLists.length > 0 ? (
                taskLists.map(list => (
                  <button
                    key={list.id}
                    onClick={() => handleSelectList(list.id, list.title)}
                    disabled={isCreating}
                    className="w-full flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors text-left disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <ListChecks size={16} className="text-gray-400" />
                      <span className="text-sm text-gray-900 dark:text-white">{list.title}</span>
                    </span>
                    <span className="text-xs text-gray-400">{list.items.length}</span>
                  </button>
                ))
              ) : (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
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
                className="w-full px-3 py-2 text-sm border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
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

      {/* Step: Confirm Remove */}
      {step === 'confirm-remove' && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {t('editor.transform.removeFromNote')}
          </p>
          <div className="flex gap-3">
            <button
              onClick={handleKeepItems}
              className="flex-1 py-2 px-4 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
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
