import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createTag, deleteTag } from './tagService';
import { Tag as TagIcon, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import clsx from 'clsx';
import { useTags } from '../../hooks/useTags';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';

export default function TagList({ onSelectTag, selectedTagId, hideHeader = false, isCreatingExternal, onCancelCreate }: {
  onSelectTag: (tagId: string | undefined) => void,
  selectedTagId?: string,
  hideHeader?: boolean,
  isCreatingExternal?: boolean,
  onCancelCreate?: () => void
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { tags } = useTags();
  const isLoading = !tags;
  const [isCreatingInternal, setIsCreatingInternal] = useState(false);
  const isCreating = isCreatingExternal || isCreatingInternal;

  // Helper to handle closing the creation input
  const handleCloseCreate = () => {
    if (onCancelCreate) {
      onCancelCreate();
    } else {
      setIsCreatingInternal(false);
    }
  };

  const [newTagName, setNewTagName] = useState('');

  const createMutation = useMutation({
    mutationFn: createTag,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      handleCloseCreate();
      setNewTagName('');
      toast.success(t('tags.created'));
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : t('tags.createFailed');
      toast.error(message);
    }
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTag,
    onSuccess: () => {
      toast.success(t('tags.deleted'));
    },
    onError: () => {
      toast.error(t('tags.deleteFailed'));
    }
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (newTagName.trim()) {
      createMutation.mutate(newTagName.trim());
    }
  };

  if (isLoading) return <div className="p-4 text-sm text-gray-500">{t('common.loading')}</div>;

  return (
    <div className="mt-1">
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 mb-2">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{t('sidebar.tags')}</h3>
          <button
            onClick={() => setIsCreatingInternal(true)}
            className="text-gray-400 hover:text-gray-600"
            title={t('tags.addTag')}
          >
            <Plus size={14} />
          </button>
        </div>
      )}

      {isCreating && (
        <form onSubmit={handleCreate} className="px-4 mb-2">
          <input
            type="text"
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            placeholder={t('tags.newTagPlaceholder')}
            className="w-full text-sm border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-green-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
            autoFocus
            onBlur={(e) => {
              // Check if we're clicking on something within the same form
              const relatedTarget = e.relatedTarget as HTMLElement;
              if (relatedTarget && e.currentTarget.form?.contains(relatedTarget)) {
                return;
              }
              // Delay closing to allow form submission
              setTimeout(() => {
                if (!newTagName.trim()) {
                  handleCloseCreate();
                }
              }, 150);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                handleCloseCreate();
                setNewTagName('');
              }
            }}
          />
        </form>
      )}

      <ul>
        {tags?.map((tag) => (
          <li key={tag.id} className="group flex items-center justify-between px-4 py-1 hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer">
            <div
              className={clsx("flex items-center flex-1 truncate", selectedTagId === tag.id && "font-semibold text-green-700 dark:text-green-400")}
              onClick={() => onSelectTag(selectedTagId === tag.id ? undefined : tag.id)}
            >
              <TagIcon size={14} className="mr-2 text-gray-400" />
              <span className="text-sm text-gray-700 dark:text-gray-300 truncate">{tag.name}</span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); deleteMutation.mutate(tag.id); }}
              className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500"
              title={t('common.delete')}
            >
              <Trash2 size={12} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
