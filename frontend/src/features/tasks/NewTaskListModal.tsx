import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import * as taskListService from './taskListService';

interface NewTaskListModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function NewTaskListModal({ isOpen, onClose }: NewTaskListModalProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setIsLoading(true);
    try {
      await taskListService.createTaskList(title.trim());
      onClose();
    } catch (err) {
      console.error('Failed to create task list', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl dark:bg-neutral-900 dark:border dark:border-neutral-800" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold text-neutral-900 dark:text-white">{t('taskLists.newList')}</h2>
          <button onClick={onClose} className="text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleCreate}>
          <input
            ref={inputRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('taskLists.editTitle')}
            className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm mb-4 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-neutral-800 dark:border-neutral-700 dark:text-white"
            required
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
            >
              {t('common.cancel')}
            </button>
            <Button type="submit" disabled={isLoading || !title.trim()} isLoading={isLoading}>
              {t('common.create')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
