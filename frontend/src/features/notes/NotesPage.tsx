import { useState, useEffect } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Search, Menu, FileDown, X, Book, FileText, PanelLeftClose, PanelLeftOpen, ChevronsLeft } from 'lucide-react';
import NoteList from './NoteList';
import { createNote, getNote } from './noteService';
import { useDebounce } from '../../hooks/useDebounce';
import clsx from 'clsx';
import { useNotes } from '../../hooks/useNotes';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../../components/ui/Button';
import SortDropdown from '../../components/ui/SortDropdown';
import NoteEditor from './NoteEditor';
import SharedUsersModal from '../../components/sharing/SharedUsersModal';
import type { SharedUserInfo, SharedOwnerInfo } from '../../components/sharing/SharedUsersModal';
import { useImport } from '../../hooks/useImport';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
import { useAuthStore } from '../../store/authStore';
import Skeleton from '../../components/ui/Skeleton';

export default function NotesPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedNoteId = searchParams.get('noteId');
  const selectedNotebookId = searchParams.get('notebookId') || undefined;
  const selectedTagId = searchParams.get('tagId') || undefined;

  const isMobile = useIsMobile();
  const { toggleSidebar, notesSortField, notesSortOrder, setNotesSort, isListCollapsed, toggleListCollapsed, collapseAll } = useUIStore();
  const user = useAuthStore((state) => state.user);
  const [showNotebookPicker, setShowNotebookPicker] = useState(false);
  const [sharingNoteId, setSharingNoteId] = useState<string | null>(null);

  const allNotebooks = useLiveQuery(async () => {
    if (!user?.id) return [];
    return db.notebooks.where('userId').equals(user.id).sortBy('name');
  }, [user?.id]);

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

  const notes = useNotes(selectedNotebookId, debouncedSearch, selectedTagId, false, ownershipFilter, notesSortField, notesSortOrder);
  const isLoading = !notes;

  const queryClient = useQueryClient();
  const { importFile, isUploading, hiddenInput, notebookPickerModal } = useImport({
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
      const nbs = allNotebooks || [];
      if (nbs.length === 0) {
        toast.error(t('notes.noNotebooks'));
        return;
      }
      if (nbs.length === 1) {
        createMutation.mutate({
          title: t('notes.untitled'),
          content: '',
          notebookId: nbs[0].id
        });
        return;
      }
      setShowNotebookPicker(true);
    }
  };

  const handlePickNotebookForCreate = (notebookId: string) => {
    setShowNotebookPicker(false);
    createMutation.mutate({
      title: t('notes.untitled'),
      content: '',
      notebookId
    });
  };

  const renderNoteList = () => {
    // const showEmptyState = !selectedNotebookId && !selectedTagId && !searchQuery;

    // if (showEmptyState) {
    //   return (
    //     <div className={clsx("flex flex-col bg-white h-full dark:bg-neutral-900 items-center justify-center text-center p-8", isMobile ? "w-full" : "w-80 border-r border-neutral-200/60 dark:border-neutral-800/40")}>
    //       <div className="mb-4 p-4 bg-emerald-50 rounded-full dark:bg-emerald-900/30">
    //         <Book size={32} className="text-emerald-600 dark:text-emerald-400" />
    //       </div>
    //       <h3 className="text-lg font-medium text-neutral-900 dark:text-white mb-2">
    //         {t('notes.noNotebookSelectedTitle')}
    //       </h3>
    //       <p className="text-sm text-neutral-500 dark:text-neutral-400">
    //         {t('notes.noNotebookSelectedDescription')}
    //       </p>
    //     </div>
    //   );
    // }

    return (
      <div className={clsx("flex flex-col bg-white h-full dark:bg-neutral-950", isMobile ? "w-full" : "w-80 border-r border-neutral-200/60 dark:border-neutral-800/40")}>
        <div className="p-4 border-b border-neutral-200/60 dark:border-neutral-800/40">
          <div className="flex items-center gap-3 mb-4 min-h-[48px]">
            {isMobile && (
              <button onClick={toggleSidebar} className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200">
                <Menu size={24} />
              </button>
            )}
            <FileText size={20} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
            <h2 className="text-xl font-semibold text-neutral-800 dark:text-white">{t('sidebar.notes')}</h2>
            <div className="ml-auto flex items-center gap-1">
              {selectedNotebookId && (
                <button
                  onClick={() => importFile(selectedNotebookId, false)}
                  disabled={isUploading}
                  className="text-neutral-500 hover:text-emerald-600 dark:text-neutral-400 dark:hover:text-emerald-400"
                  title={t('settings.importTitle')}
                >
                  <FileDown size={18} />
                </button>
              )}
              {!isMobile && (
                <>
                  <button
                    onClick={collapseAll}
                    className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-400 dark:hover:text-neutral-300 transition-colors"
                    title={t('sidebar.collapseAll')}
                    aria-label={t('sidebar.collapseAll')}
                  >
                    <ChevronsLeft size={18} />
                  </button>
                  <button
                    onClick={toggleListCollapsed}
                    className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-400 dark:hover:text-neutral-300 transition-colors"
                    title={t('common.collapseList')}
                  >
                    <PanelLeftClose size={18} />
                  </button>
                </>
              )}
            </div>
          </div>
          {hiddenInput}
          {notebookPickerModal}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400 dark:text-neutral-400" size={16} />
            <input
              type="text"
              placeholder={t('common.searchPlaceholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-neutral-300 bg-neutral-50 py-2 pl-9 pr-4 text-sm focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 dark:bg-neutral-800 dark:border-neutral-700/40 dark:text-white"
            />
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              {t('notes.found', { count: notes?.length || 0 })}
            </span>
            <div className="flex items-center gap-1">
              <SortDropdown sortField={notesSortField} sortOrder={notesSortOrder} onChange={setNotesSort} />
              {(['all', 'owned', 'shared'] as const).map(f => (
                <button key={f} onClick={() => setOwnershipFilter(f)}
                  className={clsx(
                    "px-2 py-0.5 text-[10px] rounded-full border transition-colors",
                    ownershipFilter === f
                      ? "bg-emerald-100 border-emerald-300 text-emerald-700 dark:bg-emerald-900/30 dark:border-emerald-700 dark:text-emerald-400"
                      : "bg-neutral-50 border-neutral-200/60 text-neutral-500 hover:bg-neutral-100 dark:bg-neutral-800 dark:border-neutral-700/40 dark:text-neutral-400"
                  )}>
                  {t(`notes.filter.${f}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-4">
              <Skeleton.List count={5} />
            </div>
          ) : (
            <NoteList
              notes={notes || []}
              selectedNoteId={selectedNoteId}
              onSelectNote={setSelectedNoteId}
              onShareClick={setSharingNoteId}
            />
          )}
        </div>
      </div>
    );
  };

  const renderEditor = () => (
    <div className="flex-1 flex flex-col h-full relative bg-white dark:bg-neutral-950">
      {isLoadingNote ? (
        <div className="flex h-full items-center justify-center text-neutral-400">
          {t('common.loading')}
        </div>
      ) : noteToDisplay ? (
        <NoteEditor
          key={noteToDisplay.id}
          note={noteToDisplay}
          onBack={() => setSelectedNoteId(null)}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-neutral-400 flex-col p-4 text-center dark:text-neutral-400">
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

  const notebookPickerForCreate = showNotebookPicker ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowNotebookPicker(false)}>
      <div
        className="bg-white dark:bg-neutral-800 rounded-xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200/60 dark:border-neutral-700/40">
          <div className="flex items-center gap-2">
            <Book size={18} className="text-emerald-600 dark:text-emerald-400" />
            <h3 className="text-lg font-semibold text-neutral-900 dark:text-white">
              {t('notes.selectNotebook')}
            </h3>
          </div>
          <button onClick={() => setShowNotebookPicker(false)} className="p-1 rounded-lg hover:bg-neutral-100 dark:hover:bg-neutral-700 text-neutral-500">
            <X size={18} />
          </button>
        </div>
        <div className="px-3 py-3 max-h-64 overflow-y-auto">
          {(allNotebooks || []).map(nb => (
            <button
              key={nb.id}
              onClick={() => handlePickNotebookForCreate(nb.id)}
              className="w-full text-left px-3 py-2.5 rounded-lg text-sm text-neutral-700 dark:text-neutral-200 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-900/30 dark:hover:text-emerald-400 transition-colors"
            >
              {nb.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  ) : null;

  const sharingNoteData = sharingNoteId ? notes?.find(n => n.id === sharingNoteId) : null;
  const sharingUsers: SharedUserInfo[] = sharingNoteData?.sharedWith
    ?.filter(s => s.status === 'ACCEPTED' || s.status === 'PENDING')
    .map(s => ({
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      avatarUrl: s.user.avatarUrl,
      permission: s.permission,
      status: s.status as 'ACCEPTED' | 'PENDING',
    })) || [];
  const sharingNoteOwner: SharedOwnerInfo | null = sharingNoteData
    ? (sharingNoteData.ownership === 'shared' && sharingNoteData.sharedByUser
        ? { id: sharingNoteData.sharedByUser.id, name: sharingNoteData.sharedByUser.name, email: sharingNoteData.sharedByUser.email, avatarUrl: sharingNoteData.sharedByUser.avatarUrl }
        : user ? { id: user.id, name: user.name || null, email: user.email, avatarUrl: user.avatarUrl } : null)
    : null;

  const sharingModal = sharingNoteId ? (
    <SharedUsersModal
      isOpen={!!sharingNoteId}
      onClose={() => setSharingNoteId(null)}
      users={sharingUsers}
      currentUserId={user?.id}
      owner={sharingNoteOwner}
    />
  ) : null;

  if (isMobile) {
    return (
      <div className="flex h-full bg-white w-full dark:bg-neutral-950">
        {selectedNoteId ? renderEditor() : renderNoteList()}
        {notebookPickerForCreate}
        {sharingModal}
      </div>
    );
  }

  return (
    <div className="flex h-full bg-white dark:bg-neutral-950">
      {isListCollapsed ? (
        <div className="flex flex-col items-center py-3 px-1 border-r border-neutral-200/60 dark:border-neutral-800/40 bg-neutral-50 dark:bg-neutral-950">
          <button
            onClick={toggleListCollapsed}
            className="p-1.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-400 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-lg transition-colors"
            title={t('common.expandList')}
          >
            <PanelLeftOpen size={18} />
          </button>
        </div>
      ) : (
        renderNoteList()
      )}
      {renderEditor()}
      {notebookPickerForCreate}
      {sharingModal}
    </div>
  );
}
