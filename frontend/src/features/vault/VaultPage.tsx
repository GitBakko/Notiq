import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../store/vaultStore';
import VaultSetup from './VaultSetup';
import VaultUnlock from './VaultUnlock';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
import { useSearchParams } from 'react-router-dom';
import { Search, Menu, Plus, Lock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { createNote, getNote } from '../notes/noteService';
import toast from 'react-hot-toast';
import NoteEditor from '../notes/NoteEditor';
import clsx from 'clsx';

import { useNotebooks } from '../../hooks/useNotebooks';
import TagList from '../tags/TagList';
import { useImport } from '../../hooks/useImport';
import { FileDown } from 'lucide-react';

export default function VaultPage() {
  const { t } = useTranslation();
  const { isSetup, isUnlocked, lockVault } = useVaultStore();
  const [searchQuery, setSearchQuery] = useState('');
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();
  // const navigate = useNavigate(); // Not needed
  const queryClient = useQueryClient();
  const { notebooks } = useNotebooks();
  const [searchParams, setSearchParams] = useSearchParams();

  const selectedNoteId = searchParams.get('noteId');

  const setSelectedNoteId = (id: string | null) => {
    const newParams = new URLSearchParams(searchParams);
    if (id) {
      newParams.set('noteId', id);
    } else {
      newParams.delete('noteId');
    }
    setSearchParams(newParams);
  };

  const createMutation = useMutation({
    mutationFn: createNote,
    onSuccess: (newNote) => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      // Stay in Vault, just select the new note
      setSelectedNoteId(newNote.id);
      toast.success(t('notes.created'));
    },
    onError: () => {
      toast.error(t('notes.createFailed'));
    }
  });

  const { importFile, isUploading, hiddenInput } = useImport({
    onSuccess: () => {
      // LiveQuery updates automatically? 
      // If dexie notes are updated, yes. 
      // NOTE: Import saves to MySQL (backend). Sync pulls it to Dexie. 
      // So it might take a moment to appear if Sync isn't instant.
      // We might need to trigger sync pull?
      queryClient.invalidateQueries({ queryKey: ['notes'] }); // This triggers standard react-query notes, not liveQuery?
      // Is Vault Notes using `useLiveQuery` from dexie? Yes.
      // Dexie needs to sync down.
      // Trigger a sync pull manually?
      // For MVP, user can refresh or wait for sync interval.
    }
  });

  const handleCreateSecureNote = () => {
    const defaultNotebookId = notebooks && notebooks.length > 0 ? notebooks[0].id : null;

    if (!defaultNotebookId) {
      toast.error(t('notes.noNotebooksFound'));
      return;
    }

    createMutation.mutate({
      title: t('notes.untitled'),
      notebookId: defaultNotebookId,
      isVault: true,
      isEncrypted: true
    } as any);
  };

  const vaultNotes = useLiveQuery(async () => {
    // Robust filter strategy
    const allNotes = await db.notes.toArray();

    // Sort manually in JS
    return allNotes
      .filter(note => !!note.isVault)
      .filter(note => {
        if (!searchQuery) return true;
        return note.title.toLowerCase().includes(searchQuery.toLowerCase());
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }, [searchQuery]);

  // Fetch selected note independently if needed (e.g. valid ID but not in current filtered list? slightly edge case in vault but good practice)
  const { data: fetchedNote, isLoading: isLoadingNote } = useQuery({
    queryKey: ['note', selectedNoteId],
    queryFn: () => getNote(selectedNoteId!),
    enabled: !!selectedNoteId, // Always try to fetch if ID is present
    retry: false,
  });

  // Prefer fetchedNote (has full content from GET /notes/:id) over list note (no content)
  const selectedNote = (fetchedNote || vaultNotes?.find(n => n.id === selectedNoteId)) as unknown as import('../notes/noteService').Note;

  // Auto-close if note is removed from vault
  useEffect(() => {
    if (selectedNote && !selectedNote.isVault) {
      setSearchParams((params) => {
        const newParams = new URLSearchParams(params);
        newParams.delete('noteId');
        return newParams;
      });
    }
  }, [selectedNote, setSearchParams]);

  // Lock vault on unmount
  useEffect(() => {
    return () => {
      lockVault();
    };
  }, [lockVault]);

  if (!isSetup) {
    return <VaultSetup />;
  }

  if (!isUnlocked) {
    return <VaultUnlock />;
  }

  const renderNoteList = () => (
    <div className={clsx("flex flex-col h-full bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800", isMobile ? "w-full" : "w-80")}>
      <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">
              <Menu size={24} />
            </button>
          )}
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{t('vault.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          {hiddenInput}
          <Button onClick={() => importFile(undefined, true)} variant="ghost" size="icon" className="h-8 w-8 rounded-full" title={t('settings.importTitle')} disabled={isUploading}>
            <FileDown size={16} />
          </Button>
          <Button onClick={handleCreateSecureNote} variant="primary" size="icon" className="h-8 w-8 rounded-full">
            <Plus size={16} />
          </Button>
          <Button onClick={() => lockVault()} variant="ghost" size="icon" className="h-8 w-8 rounded-full" title={t('vault.lock')}>
            <Lock size={16} />
          </Button>
        </div>
      </div>

      <div className="p-4 border-b border-gray-200 dark:border-gray-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            type="text"
            placeholder={t('common.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-gray-100 dark:bg-gray-800 border-none rounded-lg focus:ring-2 focus:ring-emerald-500 text-sm dark:text-white"
          />
        </div>
      </div>

      <div className="border-b border-gray-200 dark:border-gray-800">
        <TagList
          onSelectTag={(tagId) => {
            // Filter vault notes by tag? 
            // TODO: add tag filtering to vaultNotes query
          }}
          isVault={true}
          isCreatingExternal={false}
          hideHeader={false}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {vaultNotes?.map((note) => (
          <button
            key={note.id}
            onClick={() => setSelectedNoteId(note.id)}
            className={clsx(
              "w-full text-left p-3 rounded-lg transition-colors border",
              selectedNoteId === note.id
                ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800"
                : "bg-white dark:bg-gray-800 border-transparent hover:bg-gray-50 dark:hover:bg-gray-700/50"
            )}
          >
            <h3 className={clsx("font-medium mb-1 truncate", selectedNoteId === note.id ? "text-emerald-700 dark:text-emerald-400" : "text-gray-900 dark:text-white")}>
              {note.title || t('notes.untitled')}
            </h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-1">
              {new Date(note.updatedAt).toLocaleDateString()}
            </p>
          </button>
        ))}
        {vaultNotes?.length === 0 && (
          <div className="text-center text-gray-500 py-8 text-sm">
            {t('vault.noNotes')}
          </div>
        )}
      </div>
    </div>
  );

  const renderEditor = () => (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-gray-900 relative">
      {isLoadingNote ? (
        <div className="flex h-full items-center justify-center text-gray-400">
          {t('common.loading')}
        </div>
      ) : selectedNote ? (
        <NoteEditor
          key={selectedNote.id}
          note={selectedNote}
          onBack={() => setSelectedNoteId(null)}
        />
      ) : (
        <div className="flex h-full items-center justify-center text-gray-400 flex-col p-4 text-center dark:text-gray-500">
          <Lock size={48} className="mb-4 opacity-20" />
          <p className="mb-4">{t('notes.selectToView')}</p>
          <Button onClick={handleCreateSecureNote} variant="primary">
            {t('vault.createSecureNote')}
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
