import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getTags, createTag, deleteTag, type Tag } from './tagService';
import { Plus, Tag as TagIcon, Trash2, Menu } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InputDialog } from '../../components/ui/InputDialog';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import TagNotesSidebar from './TagNotesSidebar';

export default function TagsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [deletingTag, setDeletingTag] = useState<Tag | null>(null);
  const [selectedTag, setSelectedTag] = useState<Tag | null>(null);

  const { data: tags, isLoading } = useQuery({
    queryKey: ['tags'],
    queryFn: getTags,
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => createTag(name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.success(t('tags.created'));
      setIsCreateOpen(false);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteTag,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      toast.success(t('tags.deleted'));
      setDeletingTag(null);
      if (selectedTag?.id === deletingTag?.id) {
        setSelectedTag(null);
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (isLoading) {
    return <div className="p-8 text-center text-neutral-500">{t('common.loading')}</div>;
  }

  return (
    <div className="flex h-full bg-neutral-50 dark:bg-neutral-900 relative overflow-hidden">
      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="bg-white border-b border-neutral-200/60 px-4 py-4 sm:px-8 sm:py-6 flex items-center justify-between dark:bg-neutral-900 dark:border-neutral-800/40 flex-shrink-0">
          <div className="flex items-center gap-3">
            {isMobile && (
              <button onClick={toggleSidebar} className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200">
                <Menu size={24} />
              </button>
            )}
            <div>
              <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">{t('sidebar.tags')}</h1>
              <p className="text-sm text-neutral-500 mt-1 dark:text-neutral-400">{t('tags.count', { count: tags?.length || 0 })}</p>
            </div>
          </div>
          <Button onClick={() => setIsCreateOpen(true)} className="flex items-center gap-2">
            <Plus size={18} />
            <span className="hidden sm:inline">{t('tags.create')}</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {tags?.map((tag) => (
              <Card
                key={tag.id}
                className={`group hover:shadow-md transition-all cursor-pointer dark:bg-neutral-800 dark:border-neutral-700/40 ${selectedTag?.id === tag.id ? 'ring-2 ring-emerald-500 shadow-md' : ''}`}
                onClick={() => setSelectedTag(tag)}
              >
                <div className="p-5 flex items-center justify-between">
                  <div className="flex items-center gap-3 overflow-hidden">
                    <div className="p-2 bg-blue-100 rounded-lg text-blue-600 dark:bg-blue-900 dark:text-blue-400 flex-shrink-0">
                      <TagIcon size={20} />
                    </div>
                    <div className="min-w-0">
                      <h3 className="font-semibold text-neutral-900 truncate dark:text-white" title={tag.name}>
                        {tag.name}
                      </h3>
                      <span className="text-xs text-neutral-500 bg-neutral-100 px-2 py-1 rounded-full dark:bg-neutral-700 dark:text-neutral-300">
                        {tag._count?.notes || 0}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeletingTag(tag);
                    }}
                    className="p-2 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors opacity-0 group-hover:opacity-100 dark:hover:bg-red-900 dark:hover:text-red-400"
                    title={t('common.delete')}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </Card>
            ))}
          </div>

          {tags?.length === 0 && (
            <div className="text-center py-20">
              <div className="inline-flex p-4 bg-neutral-100 rounded-full text-neutral-400 mb-4 dark:bg-neutral-800 dark:text-neutral-500">
                <TagIcon size={48} />
              </div>
              <h3 className="text-lg font-medium text-neutral-900 mb-2 dark:text-white">{t('tags.emptyTitle')}</h3>
              <p className="text-neutral-500 mb-6 dark:text-neutral-400">{t('tags.emptyDescription')}</p>
              <Button onClick={() => setIsCreateOpen(true)}>
                {t('tags.createFirst')}
              </Button>
            </div>
          )}
        </div>
      </div>

      {selectedTag && (
        <TagNotesSidebar
          tagId={selectedTag.id}
          tagName={selectedTag.name}
          onClose={() => setSelectedTag(null)}
        />
      )}

      <InputDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onConfirm={(name) => createMutation.mutate(name)}
        title={t('tags.createTitle')}
        message={t('tags.createDescription')}
        placeholder={t('tags.namePlaceholder')}
        confirmText={t('common.create')}
      />

      <ConfirmDialog
        isOpen={!!deletingTag}
        onClose={() => setDeletingTag(null)}
        onConfirm={() => deletingTag && deleteMutation.mutate(deletingTag.id)}
        title={t('tags.deleteTitle')}
        message={t('tags.deleteConfirm', { name: deletingTag?.name })}
        confirmText={t('common.delete')}
        variant="danger"
      />
    </div>
  );
}
