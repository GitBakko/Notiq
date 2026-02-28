import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotebooks, createNotebook, updateNotebook, deleteNotebook, type Notebook } from './notebookService';
import { Plus, Book, Pencil, Trash2, Calendar, Menu } from 'lucide-react';
import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { InputDialog } from '../../components/ui/InputDialog';
import { DeleteConfirmationDialog } from '../../components/ui/DeleteConfirmationDialog';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';

export default function NotebooksPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingNotebook, setEditingNotebook] = useState<Notebook | null>(null);
  const [deletingNotebook, setDeletingNotebook] = useState<Notebook | null>(null);

  const { data: notebooks, isLoading } = useQuery({
    queryKey: ['notebooks'],
    queryFn: getNotebooks,
  });

  const createMutation = useMutation({
    mutationFn: createNotebook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notebooks'] });
      toast.success(t('notebooks.created'));
      setIsCreateOpen(false);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => updateNotebook(id, name),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notebooks'] });
      toast.success(t('notebooks.updated'));
      setEditingNotebook(null);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteNotebook,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notebooks'] });
      toast.success(t('notebooks.deleted'));
      setDeletingNotebook(null);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (isLoading) {
    return <div className="p-8 text-center text-neutral-500">{t('common.loading')}</div>;
  }

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-neutral-900">
      <div className="bg-white border-b border-neutral-200/60 px-4 py-4 sm:px-8 sm:py-6 flex items-center justify-between dark:bg-neutral-900 dark:border-neutral-800/40">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200">
              <Menu size={24} />
            </button>
          )}
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">{t('sidebar.notebooks')}</h1>
            <p className="text-sm text-neutral-500 mt-1 dark:text-neutral-400">{t('notebooks.count', { count: notebooks?.length || 0 })}</p>
          </div>
        </div>
        <Button onClick={() => setIsCreateOpen(true)} className="flex items-center gap-2">
          <Plus size={18} />
          <span className="hidden sm:inline">{t('notebooks.create')}</span>
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {notebooks?.map((notebook) => (
            <Card key={notebook.id} className="group hover:shadow-md transition-shadow dark:bg-neutral-800 dark:border-neutral-700/40">
              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 bg-emerald-100 rounded-lg text-emerald-600 dark:bg-emerald-900 dark:text-emerald-400">
                    <Book size={24} />
                  </div>
                  <div className="relative">
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => setEditingNotebook(notebook)}
                        className="p-1.5 text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors dark:hover:bg-emerald-900/30"
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        onClick={() => setDeletingNotebook(notebook)}
                        className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors dark:hover:bg-red-900/30"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>
                <h3 className="font-semibold text-neutral-900 mb-1 truncate dark:text-white" title={notebook.name}>
                  {notebook.name}
                </h3>
                <div className="flex items-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
                  <span className="flex items-center gap-1">
                    <Calendar size={12} />
                    {format(new Date(notebook.updatedAt), 'MMM d, yyyy')}
                  </span>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {notebooks?.length === 0 && (
          <div className="text-center py-20">
            <div className="inline-flex p-4 bg-neutral-100 rounded-full text-neutral-400 mb-4 dark:bg-neutral-800 dark:text-neutral-500">
              <Book size={48} />
            </div>
            <h3 className="text-lg font-medium text-neutral-900 mb-2 dark:text-white">{t('notebooks.emptyTitle')}</h3>
            <p className="text-neutral-500 mb-6 dark:text-neutral-400">{t('notebooks.emptyDescription')}</p>
            <Button onClick={() => setIsCreateOpen(true)}>
              {t('notebooks.createFirst')}
            </Button>
          </div>
        )}
      </div>

      <InputDialog
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onConfirm={(name) => createMutation.mutate(name)}
        title={t('notebooks.create')}
        placeholder={t('notebooks.namePlaceholder')}
        confirmText={t('common.create')}
      />

      <InputDialog
        isOpen={!!editingNotebook}
        onClose={() => setEditingNotebook(null)}
        onConfirm={(name) => {
          if (editingNotebook) {
            updateMutation.mutate({ id: editingNotebook.id, name });
          }
        }}
        title={t('notebooks.edit')}
        defaultValue={editingNotebook?.name}
        placeholder={t('notebooks.namePlaceholder')}
        confirmText={t('common.save')}
      />

      <DeleteConfirmationDialog
        isOpen={!!deletingNotebook}
        onClose={() => setDeletingNotebook(null)}
        onConfirm={() => {
          if (deletingNotebook) {
            deleteMutation.mutate(deletingNotebook.id);
          }
        }}
        itemName={deletingNotebook?.name || ''}
        title={t('notebooks.deleteTitle')}
        description={t('notebooks.deleteDescription')}
      />
    </div>
  );
}
