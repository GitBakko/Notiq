import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useVaultStore } from '../../store/vaultStore';
import VaultSetup from './VaultSetup';
import VaultUnlock from './VaultUnlock';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../lib/db';
import { useSearchParams } from 'react-router-dom';
import { Search, Menu, Plus, Lock, KeyRound, PanelLeftClose, PanelLeftOpen, ChevronsLeft } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createNote } from '../notes/noteService';
import toast from 'react-hot-toast';
import NoteEditor from '../notes/NoteEditor';
import clsx from 'clsx';

import { useNotebooks } from '../../hooks/useNotebooks';
import SortDropdown from '../../components/ui/SortDropdown';
import TagList from '../tags/TagList';
import { useImport } from '../../hooks/useImport';
import { FileDown } from 'lucide-react';
import CredentialCard from './CredentialCard';
import CredentialForm from './CredentialForm';
import { encryptCredential, EMPTY_CREDENTIAL, decryptCredential } from './credentialTypes';

type TypeFilter = 'all' | 'note' | 'credential';

export default function VaultPage() {
  const { t } = useTranslation();
  const { isSetup, isUnlocked, lockVault, pin } = useVaultStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const { toggleSidebar, notesSortField, notesSortOrder, setNotesSort, isListCollapsed, toggleListCollapsed, collapseAll } = useUIStore();
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
      setSelectedNoteId(newNote.id);
      toast.success(t('notes.created'));
    },
    onError: () => {
      toast.error(t('notes.createFailed'));
    }
  });

  const { importFile, isUploading, hiddenInput, notebookPickerModal } = useImport({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    }
  });

  const getDefaultNotebookId = () => {
    return notebooks && notebooks.length > 0 ? notebooks[0].id : null;
  };

  const handleCreateSecureNote = () => {
    const notebookId = getDefaultNotebookId();
    if (!notebookId) { toast.error(t('notes.noNotebooksFound')); return; }
    setShowCreateMenu(false);
    createMutation.mutate({
      title: t('notes.untitled'),
      notebookId,
      isVault: true,
      isEncrypted: true,
      noteType: 'NOTE',
    });
  };

  const handleCreateCredential = () => {
    const notebookId = getDefaultNotebookId();
    if (!notebookId) { toast.error(t('notes.noNotebooksFound')); return; }
    if (!pin) return;
    setShowCreateMenu(false);
    const encrypted = encryptCredential(EMPTY_CREDENTIAL, pin);
    createMutation.mutate({
      title: t('vault.credential.untitled'),
      notebookId,
      isVault: true,
      isEncrypted: true,
      noteType: 'CREDENTIAL',
      content: encrypted,
    });
  };

  const vaultNotes = useLiveQuery(async () => {
    const allNotes = await db.notes.toArray();

    return allNotes
      .filter(note => !!note.isVault && !note.isTrashed)
      .filter(note => {
        if (typeFilter === 'note') return note.noteType !== 'CREDENTIAL';
        if (typeFilter === 'credential') return note.noteType === 'CREDENTIAL';
        return true;
      })
      .filter(note => {
        if (!selectedTagId) return true;
        return note.tags?.some((tagEntry: { tag?: { id: string } }) => tagEntry.tag?.id === selectedTagId);
      })
      .filter(note => {
        if (!searchQuery) return true;
        const q = searchQuery.toLowerCase();
        if (note.title.toLowerCase().includes(q)) return true;
        // For credentials, also search siteUrl and username
        if (note.noteType === 'CREDENTIAL' && pin && note.content) {
          const data = decryptCredential(note.content, pin);
          if (data) {
            return data.siteUrl?.toLowerCase().includes(q)
              || data.username?.toLowerCase().includes(q);
          }
        }
        return false;
      })
      .sort((a, b) => {
        if (notesSortField === 'title') {
          const cmp = (a.title || '').localeCompare(b.title || '');
          return notesSortOrder === 'asc' ? cmp : -cmp;
        }
        const dateA = new Date(a[notesSortField]).getTime();
        const dateB = new Date(b[notesSortField]).getTime();
        return notesSortOrder === 'asc' ? dateA - dateB : dateB - dateA;
      });
  }, [searchQuery, typeFilter, pin, selectedTagId, notesSortField, notesSortOrder]);

  // Vault notes use Dexie as source of truth (encrypted content saved locally first, sync is async)
  const selectedNote = vaultNotes?.find(n => n.id === selectedNoteId) as unknown as import('../notes/noteService').Note | undefined;

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

  // Close create menu on outside click
  useEffect(() => {
    if (!showCreateMenu) return;
    const handle = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-create-menu]')) setShowCreateMenu(false);
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showCreateMenu]);

  if (!isSetup) {
    return <VaultSetup />;
  }

  if (!isUnlocked) {
    return <VaultUnlock />;
  }

  const filterChips: { key: TypeFilter; label: string }[] = [
    { key: 'all', label: t('vault.filterAll') },
    { key: 'note', label: t('vault.filterNote') },
    { key: 'credential', label: t('vault.filterCredential') },
  ];

  const renderNoteList = () => (
    <div className={clsx("flex flex-col h-full bg-white dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-800", isMobile ? "w-full" : "w-80")}>
      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between min-h-[48px]">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200">
              <Menu size={24} />
            </button>
          )}
          <Lock size={20} className="text-emerald-600 dark:text-emerald-400 flex-shrink-0" />
          <h1 className="text-xl font-bold text-neutral-900 dark:text-white">{t('vault.title')}</h1>
        </div>
        <div className="flex items-center gap-2">
          {hiddenInput}
          {notebookPickerModal}
          <Button onClick={() => importFile(undefined, true)} variant="ghost" size="icon" className="h-8 w-8 rounded-full" title={t('settings.importTitle')} disabled={isUploading}>
            <FileDown size={16} />
          </Button>
          {/* Create dropdown */}
          <div className="relative" data-create-menu>
            <Button onClick={() => setShowCreateMenu(!showCreateMenu)} variant="primary" size="icon" className="h-8 w-8 rounded-full">
              <Plus size={16} />
            </Button>
            {showCreateMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg overflow-hidden min-w-[180px]">
                <button
                  onClick={handleCreateSecureNote}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                >
                  <Lock size={14} />
                  {t('vault.createSecureNote')}
                </button>
                <button
                  onClick={handleCreateCredential}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-neutral-700 dark:text-neutral-200 hover:bg-neutral-50 dark:hover:bg-neutral-700"
                >
                  <KeyRound size={14} />
                  {t('vault.createCredential')}
                </button>
              </div>
            )}
          </div>
          <Button onClick={() => lockVault()} variant="ghost" size="icon" className="h-8 w-8 rounded-full" title={t('vault.lock')}>
            <Lock size={16} />
          </Button>
          {!isMobile && (
            <>
              <button
                onClick={collapseAll}
                className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
                title={t('sidebar.collapseAll')}
                aria-label={t('sidebar.collapseAll')}
              >
                <ChevronsLeft size={18} />
              </button>
              <button
                onClick={toggleListCollapsed}
                className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 transition-colors"
                title={t('common.collapseList')}
              >
                <PanelLeftClose size={18} />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="p-4 border-b border-neutral-200 dark:border-neutral-800">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} />
          <input
            type="text"
            placeholder={t('common.search')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-4 py-2 bg-neutral-100 dark:bg-neutral-800 border-none rounded-lg focus:ring-2 focus:ring-emerald-500 text-sm dark:text-white"
          />
        </div>
        {/* Type filter chips + sort */}
        <div className="flex items-center gap-1 mt-2">
          {filterChips.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTypeFilter(key)}
              className={clsx(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                typeFilter === key
                  ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                  : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
              )}
            >
              {label}
            </button>
          ))}
          <SortDropdown sortField={notesSortField} sortOrder={notesSortOrder} onChange={setNotesSort} />
        </div>
      </div>

      <div className="border-b border-neutral-200 dark:border-neutral-800">
        <TagList
          onSelectTag={(tagId) => setSelectedTagId(tagId === selectedTagId ? null : tagId ?? null)}
          selectedTagId={selectedTagId ?? undefined}
          isVault={true}
          isCreatingExternal={false}
          hideHeader={false}
        />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {vaultNotes?.map((note) => (
          note.noteType === 'CREDENTIAL' ? (
            <CredentialCard
              key={note.id}
              note={note}
              isSelected={selectedNoteId === note.id}
              onClick={() => setSelectedNoteId(note.id)}
            />
          ) : (
            <button
              key={note.id}
              onClick={() => setSelectedNoteId(note.id)}
              className={clsx(
                "w-full text-left p-3 rounded-lg transition-colors border",
                selectedNoteId === note.id
                  ? "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800"
                  : "bg-white dark:bg-neutral-800 border-transparent hover:bg-neutral-50 dark:hover:bg-neutral-700/50"
              )}
            >
              <h3 className={clsx("font-medium mb-1 truncate", selectedNoteId === note.id ? "text-emerald-700 dark:text-emerald-400" : "text-neutral-900 dark:text-white")}>
                {note.title || t('notes.untitled')}
              </h3>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-1">
                {new Date(note.updatedAt).toLocaleDateString()}
              </p>
            </button>
          )
        ))}
        {vaultNotes?.length === 0 && (
          <div className="text-center text-neutral-500 py-8 text-sm">
            {t('vault.noNotes')}
          </div>
        )}
      </div>
    </div>
  );

  const renderEditor = () => (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-neutral-900 relative">
      {selectedNote ? (
        selectedNote.noteType === 'CREDENTIAL' ? (
          <CredentialForm
            key={selectedNote.id}
            note={selectedNote}
            onBack={() => setSelectedNoteId(null)}
            onDelete={() => setSelectedNoteId(null)}
          />
        ) : (
          <NoteEditor
            key={selectedNote.id}
            note={selectedNote}
            onBack={() => setSelectedNoteId(null)}
          />
        )
      ) : (
        <div className="flex h-full items-center justify-center text-neutral-400 flex-col p-4 text-center dark:text-neutral-500">
          <Lock size={48} className="mb-4 opacity-20" />
          <p className="mb-4">{t('notes.selectToView')}</p>
          <div className="flex gap-2">
            <Button onClick={handleCreateSecureNote} variant="primary">
              {t('vault.createSecureNote')}
            </Button>
            <Button onClick={handleCreateCredential} variant="secondary">
              <KeyRound size={16} className="mr-1" />
              {t('vault.createCredential')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <div className="flex h-full bg-white w-full dark:bg-neutral-900">
        {selectedNoteId ? renderEditor() : renderNoteList()}
      </div>
    );
  }

  return (
    <div className="flex h-full bg-white dark:bg-neutral-900">
      {isListCollapsed ? (
        <div className="flex flex-col items-center py-3 px-1 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
          <button
            onClick={toggleListCollapsed}
            className="p-1.5 text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 rounded-md transition-colors"
            title={t('common.expandList')}
          >
            <PanelLeftOpen size={18} />
          </button>
        </div>
      ) : (
        renderNoteList()
      )}
      {renderEditor()}
    </div>
  );
}
