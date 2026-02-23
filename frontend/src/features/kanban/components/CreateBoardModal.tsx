import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../../../components/ui/Modal';
import { Button } from '../../../components/ui/Button';
import { useKanbanMutations } from '../hooks/useKanbanMutations';

interface CreateBoardModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CreateBoardModal({ isOpen, onClose }: CreateBoardModalProps) {
  const { t } = useTranslation();
  const { createBoard } = useKanbanMutations();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setDescription('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!title.trim()) return;

    createBoard.mutate(
      { title: title.trim(), description: description.trim() || undefined },
      {
        onSuccess: () => {
          setTitle('');
          setDescription('');
          onClose();
        },
      },
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kanban.newBoard')}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('kanban.boardTitle')}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
          required
        />

        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('kanban.boardDescription')}
          rows={3}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-none focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
        />

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200"
          >
            {t('common.cancel')}
          </button>
          <Button
            type="submit"
            disabled={createBoard.isPending || !title.trim()}
            isLoading={createBoard.isPending}
          >
            {t('common.create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
