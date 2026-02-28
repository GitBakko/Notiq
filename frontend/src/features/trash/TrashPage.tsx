import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { restoreNote, permanentlyDeleteNote, type Note } from '../notes/noteService';
import { Trash2, RefreshCw, Menu, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Button } from '../../components/ui/Button';
import { Card } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { useNotes } from '../../hooks/useNotes';

export default function TrashPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const [deletingNote, setDeletingNote] = useState<Note | null>(null);
  const [isEmptyTrashConfirmOpen, setIsEmptyTrashConfirmOpen] = useState(false);

  // Fetch trashed notes
  const notes = useNotes(undefined, undefined, undefined, true);

  const restoreMutation = useMutation({
    mutationFn: restoreNote,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      toast.success(t('trash.restored'));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: permanentlyDeleteNote,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      toast.success(t('trash.deletedForever'));
      setDeletingNote(null);
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const handleEmptyTrash = () => {
    if (!notes || notes.length === 0) return;
    setIsEmptyTrashConfirmOpen(true);
  };

  const confirmEmptyTrash = async () => {
    if (!notes) return;
    for (const note of notes) {
      await deleteMutation.mutateAsync(note.id);
    }
    setIsEmptyTrashConfirmOpen(false);
  };

  return (
    <div className="flex flex-col h-full bg-neutral-50 dark:bg-neutral-900">
      <div className="bg-white border-b border-neutral-200 px-4 py-4 sm:px-8 sm:py-6 flex items-center justify-between dark:bg-neutral-900 dark:border-neutral-800">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200">
              <Menu size={24} />
            </button>
          )}
          <div>
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">{t('sidebar.trash')}</h1>
            <p className="text-sm text-neutral-500 mt-1 dark:text-neutral-400">{t('trash.count', { count: notes?.length || 0 })}</p>
          </div>
        </div>
        {notes && notes.length > 0 && (
          <Button onClick={handleEmptyTrash} variant="danger" className="flex items-center gap-2">
            <Trash2 size={18} />
            <span className="hidden sm:inline">{t('trash.emptyTrash')}</span>
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {notes?.map((note) => (
            <Card key={note.id} className="group hover:shadow-md transition-shadow dark:bg-neutral-800 dark:border-neutral-700">
              <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 bg-neutral-100 rounded-lg text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300">
                    <FileText size={24} />
                  </div>
                  <div className="relative">
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => restoreMutation.mutate(note.id)}
                        className="p-1.5 text-neutral-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-md transition-colors dark:hover:bg-emerald-900 dark:hover:text-emerald-400"
                        title={t('trash.restore')}
                      >
                        <RefreshCw size={16} />
                      </button>
                      <button
                        onClick={() => setDeletingNote(note)}
                        className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors dark:hover:bg-red-900 dark:hover:text-red-400"
                        title={t('trash.deleteForever')}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                </div>

                <h3 className="font-semibold text-neutral-900 mb-1 truncate dark:text-white" title={note.title}>
                  {note.title}
                </h3>
                <p className="text-xs text-neutral-500 line-clamp-2 h-8 mb-4 dark:text-neutral-400">
                  {(() => {
                    try {
                      // Attempt to parse as JSON first
                      const jsonContent = JSON.parse(note.content);
                      // Simple text extraction from Tiptap JSON
                      const text = jsonContent.content?.map((p: { content?: { text?: string }[] }) => p.content?.map((c) => c.text).join('')).join(' ') || '';
                      return text || t('notes.noContent');
                    } catch {
                      // Fallback to plain text / HTML strip (legacy)
                      return note.content.replace(/<[^>]*>?/gm, '') || t('notes.noContent');
                    }
                  })()}
                </p>

                <div className="flex items-center gap-2 text-xs text-neutral-500 pt-4 border-t border-neutral-100 dark:border-neutral-700 dark:text-neutral-400">
                  <span>{t('trash.deleted')}: {new Date(note.updatedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>

        {notes?.length === 0 && (
          <div className="text-center py-20">
            <div className="inline-flex p-4 bg-neutral-100 rounded-full text-neutral-400 mb-4 dark:bg-neutral-800 dark:text-neutral-500">
              <Trash2 size={48} />
            </div>
            <h3 className="text-lg font-medium text-neutral-900 mb-2 dark:text-white">{t('trash.emptyTitle')}</h3>
            <p className="text-neutral-500 dark:text-neutral-400">{t('trash.emptyDescription')}</p>
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!deletingNote}
        onClose={() => setDeletingNote(null)}
        onConfirm={() => deletingNote && deleteMutation.mutate(deletingNote.id)}
        title={t('trash.deleteTitle')}
        message={t('trash.deleteConfirm')}
        confirmText={t('common.deleteForever')}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={isEmptyTrashConfirmOpen}
        onClose={() => setIsEmptyTrashConfirmOpen(false)}
        onConfirm={confirmEmptyTrash}
        title={t('trash.emptyTrashTitle', 'Empty Trash')}
        message={t('trash.emptyConfirm', 'Are you sure you want to permanently delete all notes in the trash?')}
        confirmText={t('trash.emptyTrash')}
        variant="danger"
      />
    </div>
  );
}
