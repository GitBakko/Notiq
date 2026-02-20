import { useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Search, Menu } from 'lucide-react';
import NoteList from './NoteList';
import { createNote, getNote } from './noteService';
import { useDebounce } from '../../hooks/useDebounce';
import clsx from 'clsx';
import { useNotes } from '../../hooks/useNotes';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../../components/ui/Button';
import NoteEditor from './NoteEditor';
import { FileDown } from 'lucide-react';
import { useImport } from '../../hooks/useImport';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

export default function NotesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedNoteId = searchParams.get('noteId');
  const selectedNotebookId = searchParams.get('notebookId') || undefined;
  const selectedTagId = searchParams.get('tagId') || undefined;

  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const setSelectedNoteId = (id: string | null) => {
    const newParams = new URLSearchParams(searchParams);
    if (id) {
      newParams.set('noteId', id);
    } else {
      newParams.delete('noteId');
    }
    setSearchParams(newParams);
  };

  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearch = useDebounce(searchQuery, 500);
  const [ownershipFilter, setOwnershipFilter] = useState<'all' | 'owned' | 'shared'>('all');

  const notes = useNotes(selectedNotebookId, debouncedSearch, selectedTagId, false, ownershipFilter);
  const isLoading = !notes;

  const queryClient = useQueryClient();
  const { importFile, isUploading, hiddenInput } = useImport({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    }
  });

  const selectedNote = notes?.find((n) => n.id === selectedNoteId);

  const { data: fetchedNote, isLoading: isLoadingNote } = useQuery({
    queryKey: ['note', selectedNoteId],
    queryFn: () => getNote(selectedNoteId!),
    enabled: !!selectedNoteId,
    retry: false,
  });

  // Prefer fetchedNote (has full content from GET /notes/:id) over selectedNote (from list, no content)
  const noteToDisplay = fetchedNote || selectedNote;

  // Auto-close if note is moved to vault (or if opened via link but is vault)
  useEffect(() => {
    if (noteToDisplay?.isVault) {
      setSelectedNoteId(null);
      // Optional: Redirect to vault? For now just close.
    }
  }, [noteToDisplay, setSearchParams]);

  const createMutation = useMutation({
    mutationFn: createNote,
    onSuccess: (newNote) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      setSelectedNoteId(newNote.id);
    },
  });

  const handleCreateNote = () => {
    if (selectedNotebookId) {
      createMutation.mutate({
        title: t('notes.untitled'),
        content: '',
        notebookId: selectedNotebookId
      });
    } else {
      toast.error(t('notes.selectNotebookFirst'));
    }
  };

  const renderNoteList = () => {
    // const showEmptyState = !selectedNotebookId && !selectedTagId && !searchQuery;

    // if (showEmptyState) {
    //   return (
    //     <div className={clsx("flex flex-col bg-white h-full dark:bg-gray-900 items-center justify-center text-center p-8", isMobile ? "w-full" : "w-80 border-r border-gray-200 dark:border-gray-800")}>
    //       <div className="mb-4 p-4 bg-emerald-50 rounded-full dark:bg-emerald-900/30">
    //         <Book size={32} className="text-emerald-600 dark:text-emerald-400" />
    //       </div>
    //       <h3 className="text-lg font-medium text-gray-900 dark:text-white mb-2">
    //         {t('notes.noNotebookSelectedTitle')}
    //       </h3>
    //       <p className="text-sm text-gray-500 dark:text-gray-400">
    //         {t('notes.noNotebookSelectedDescription')}
    //       </p>
    //     </div>
    //   );
    // }

    return (
      <div className={clsx("flex flex-col bg-white h-full dark:bg-gray-900", isMobile ? "w-full" : "w-80 border-r border-gray-200 dark:border-gray-800")}>
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <div className="flex items-center gap-3 mb-4">
            {isMobile && (
              <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">
                <Menu size={24} />
              </button>
            )}
            <h2 className="text-xl font-semibold text-gray-800 dark:text-white">{t('sidebar.notes')}</h2>
            {selectedNotebookId && (
              <button
                onClick={() => importFile(selectedNotebookId, false)}
                disabled={isUploading}
                className="ml-auto text-gray-500 hover:text-emerald-600 dark:text-gray-400 dark:hover:text-emerald-400"
                title={t('settings.importTitle')}
              >
                <FileDown size={18} />
              </button>
            )}
          </div>
          {hiddenInput}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500" size={16} />
            <input
              type="text"
              placeholder={t('common.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-gray-300 bg-gray-50 py-2 pl-9 pr-4 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-gray-800 dark:border-gray-700 dark:text-white"
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {t('notes.found', { count: notes?.length || 0 })}
            </span>
            <div className="flex gap-1">
              {(['all', 'owned', 'shared'] as const).map(f => (
                <button key={f} onClick={() => setOwnershipFilter(f)}
                  className={clsx(
                    "px-2 py-0.5 text-[10px] rounded-full border transition-colors",
                    ownershipFilter === f
                      ? "bg-emerald-100 border-emerald-300 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-400"
                      : "bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-400"
                  )}>
                  {t(`notes.filter.${f}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-4 text-center text-gray-500 dark:text-gray-400">{t('common.loading')}</div>
          ) : (
            <NoteList
              notes={notes || []}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
            />
          )}
        </div>
      </div>
    );
  };

  const renderEditor = () => (
    <div className="flex-1 flex flex-col h-full relative bg-white dark:bg-gray-900">
      {isLoadingNote ? (
        <div className="flex h-full items-center justify-center text-gray-400">
          {t('common.loading')}
        </div>
      ) : noteToDisplay ? (
        <NoteEditor
          key={noteToDisplay.id}
          note={noteToDisplay}
          onBack={() => setSelectedNoteId(null)}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-gray-400 flex-col p-4 text-center dark:text-gray-500">
          <p className="mb-4">{t('notes.selectToView')}</p>
          <Button
            onClick={handleCreateNote}
            variant="primary"
          >
            {t('notes.createNew')}
          </Button>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div className="flex h-full bg-white w-full dark:bg-gray-900">
        {selectedNoteId ? renderEditor() : renderNoteList()}
      </div>
    );
  }

  return (
    <div className="flex h-full bg-white dark:bg-gray-900">
      {renderNoteList()}
      {renderEditor()}
    </div>
  );
}
