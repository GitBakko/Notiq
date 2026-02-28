import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Search, ListChecks, X, Link2 } from 'lucide-react';
import clsx from 'clsx';
import Modal from '../../../components/ui/Modal';
import * as kanbanService from '../kanbanService';

interface TaskListLinkPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (taskListId: string) => void;
}

export default function TaskListLinkPicker({ isOpen, onClose, onSelect }: TaskListLinkPickerProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Focus input when modal opens
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 100);
      setSearchQuery('');
      setDebouncedQuery('');
    }
  }, [isOpen]);

  const { data: taskLists, isLoading } = useQuery({
    queryKey: ['kanban-tasklist-search', debouncedQuery],
    queryFn: () => kanbanService.searchTaskLists(debouncedQuery),
    enabled: isOpen,
  });

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('kanban.linking.linkTaskList')} size="md">
      <div className="space-y-4">
        {/* Search input */}
        <div className="relative">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-500"
          />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t('kanban.linking.searchTaskLists')}
            className="w-full pl-9 pr-8 py-2 text-sm bg-neutral-50 dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg text-neutral-900 dark:text-white placeholder-neutral-400 dark:placeholder-neutral-500 outline-none focus:border-emerald-500 dark:focus:border-emerald-500"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* Results */}
        <div className="max-h-64 overflow-y-auto space-y-1">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : taskLists && taskLists.length > 0 ? (
            taskLists.map((tl) => {
              const isLinked = !!tl.linkedBoardId;
              return (
                <button
                  key={tl.id}
                  onClick={() => !isLinked && onSelect(tl.id)}
                  disabled={isLinked}
                  className={clsx(
                    'w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors',
                    isLinked
                      ? 'opacity-60 cursor-not-allowed'
                      : 'hover:bg-neutral-100 dark:hover:bg-neutral-800'
                  )}
                >
                  <ListChecks size={16} className="text-blue-500 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-neutral-900 dark:text-white truncate">
                      {tl.title}
                    </p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-neutral-400 dark:text-neutral-500">
                        {tl.itemCount} {tl.itemCount === 1 ? 'item' : 'items'}
                      </span>
                      {isLinked && (
                        <span className="flex items-center gap-1 text-xs text-amber-500 dark:text-amber-400">
                          <Link2 size={10} />
                          {t('kanban.linking.alreadyLinked')}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          ) : (
            <p className="text-center text-sm text-neutral-400 dark:text-neutral-500 py-8">
              {t('kanban.linking.noTaskLists')}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}
