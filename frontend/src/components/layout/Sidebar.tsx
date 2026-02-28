import { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Search, Settings, ChevronRight, ChevronDown, Book, Trash2, LogOut, Moon, Sun, Monitor, Star, Lock, Share2, Users, Orbit, FileText, Bell, ListChecks, Kanban, XCircle, UserPen, Pencil, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useLocation, Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { useNotebooks } from '../../hooks/useNotebooks';
import { useNotes } from '../../hooks/useNotes';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';
import { useUIStore } from '../../store/uiStore';
import { InputDialog } from '../ui/InputDialog';
import { DeleteConfirmationDialog } from '../ui/DeleteConfirmationDialog';
import { createNotebook, deleteNotebook, updateNotebook } from '../../features/notebooks/notebookService';
import { createNote, permanentlyDeleteNote } from '../../features/notes/noteService';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import TagList from '../../features/tags/TagList';
import { CURRENT_VERSION } from '../../data/changelog';
import { usePinnedNotes } from '../../hooks/usePinnedNotes';
import { useImport } from '../../hooks/useImport';
import NotebookSharingModal from '../sharing/NotebookSharingModal';
import SharedUsersModal from '../sharing/SharedUsersModal';
import type { SharedUserInfo } from '../sharing/SharedUsersModal';
import { useNotebookShareCounts } from '../../hooks/useNotebookShareCounts';
import toast from 'react-hot-toast';
import NotificationDropdown from '../../features/notifications/NotificationDropdown';
import { useIsMobile } from '../../hooks/useIsMobile';

export default function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedTagId = searchParams.get('tagId') || undefined;

  const { user, logout } = useAuthStore();
  const { theme, setTheme, openSearch, closeSidebar, isSidebarCollapsed, toggleSidebarCollapsed } = useUIStore();
  const isMobile = useIsMobile();
  const [isNotebooksOpen, setIsNotebooksOpen] = useState(true);
  const [isNewNotebookOpen, setIsNewNotebookOpen] = useState(false);
  const [isTagsOpen, setIsTagsOpen] = useState(true);
  const [isNewTagOpen, setIsNewTagOpen] = useState(false);
  const [sharingNotebookId, setSharingNotebookId] = useState<string | null>(null);
  const [viewSharesNotebookId, setViewSharesNotebookId] = useState<string | null>(null);

  const [deleteNotebookId, setDeleteNotebookId] = useState<string | null>(null);
  const [deleteNotebookName, setDeleteNotebookName] = useState('');
  const [isEmptyTrashConfirmOpen, setIsEmptyTrashConfirmOpen] = useState(false);
  const [renamingNotebookId, setRenamingNotebookId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { notebooks } = useNotebooks();
  const { data: notebookShareCounts } = useNotebookShareCounts();
  const pinnedNotes = usePinnedNotes();
  const { isUploading, importFile, hiddenInput, notebookPickerModal } = useImport();
  const { isUploading: isUploadingOneNote, importFile: importFileOneNote, hiddenInput: hiddenInputOneNote, notebookPickerModal: notebookPickerModalOneNote } = useImport({ source: 'onenote' });

  const handleCreateNote = async () => {
    let defaultNotebookId: string;

    if (!notebooks || notebooks.length === 0) {
      try {
        const nb = await createNotebook(t('notebooks.firstNotebook'));
        defaultNotebookId = nb.id;
      } catch (e) {
        console.error('Failed to create default notebook', e);
        return;
      }
    } else {
      defaultNotebookId = notebooks[0].id;
    }

    try {
      const newNote = await createNote({
        title: '',
        notebookId: defaultNotebookId,
        content: ''
      });
      navigate(`/notes?noteId=${newNote.id}`);
    } catch (error) {
      console.error('Failed to create note', error);
    }
  };

  const handleSelectTag = (tagId: string | undefined) => {
    if (tagId) {
      navigate(`/notes?tagId=${tagId}`);
    } else {
      navigate('/notes');
    }
  };

  const toggleTheme = () => {
    if (theme === 'light') setTheme('dark');
    else if (theme === 'dark') setTheme('system');
    else setTheme('light');
  };

  const getThemeIcon = () => {
    if (theme === 'light') return <Sun size={16} />;
    if (theme === 'dark') return <Moon size={16} />;
    return <Monitor size={16} />;
  };

  const handleDeleteNotebook = async () => {
    if (!deleteNotebookId) return;
    try {
      await deleteNotebook(deleteNotebookId);
      toast.success(t('notebooks.deleted'));
      if (location.search.includes(deleteNotebookId)) {
        navigate('/notes');
      }
    } catch {
      toast.error(t('notebooks.deleteFailed'));
    }
  };



  const startRename = useCallback((notebookId: string, currentName: string) => {
    setRenamingNotebookId(notebookId);
    setRenameText(currentName);
  }, []);

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingNotebookId) return;
    const trimmed = renameText.trim();
    const notebook = notebooks?.find(n => n.id === renamingNotebookId);
    if (!trimmed || trimmed === notebook?.name) {
      setRenamingNotebookId(null);
      return;
    }
    try {
      await updateNotebook(renamingNotebookId, trimmed);
      toast.success(t('notebooks.renamed'));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t('notebooks.renameFailed'));
    }
    setRenamingNotebookId(null);
  }, [renamingNotebookId, renameText, notebooks, t]);

  const handleRenameCancel = useCallback(() => {
    setRenamingNotebookId(null);
  }, []);

  // Focus rename input when it appears
  useEffect(() => {
    if (renamingNotebookId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingNotebookId]);

  const confirmEmptyTrash = async () => {
    if (!trashedNotes || trashedNotes.length === 0) return;
    try {
      for (const note of trashedNotes) {
        await permanentlyDeleteNote(note.id);
      }
      toast.success(t('trash.emptied', 'Trash emptied'));
    } catch {
      toast.error(t('trash.emptyFailed', 'Failed to empty trash'));
    }
    setIsEmptyTrashConfirmOpen(false);
  };

  // We need a specific query for trash count across all notebooks
  const trashedNotes = useNotes(undefined, undefined, undefined, true);
  const trashCount = trashedNotes?.length || 0;

  const navItems: { icon: typeof FileText; label: string; path: string; count?: number }[] = [
    { icon: FileText, label: t('sidebar.notes'), path: '/notes' },
    { icon: Bell, label: t('sidebar.reminders'), path: '/reminders' },
    { icon: ListChecks, label: t('sidebar.taskLists'), path: '/tasks' },
    { icon: Kanban, label: t('sidebar.kanban'), path: '/kanban' },
    // Notebooks is handled separately
    { icon: Users, label: t('sharing.title'), path: '/shared' },
    { icon: Orbit, label: t('groups.title'), path: '/groups' },
    { icon: Lock, label: t('vault.title'), path: '/vault' },
    { icon: Trash2, label: t('sidebar.trash'), path: '/trash', count: trashCount },
  ];

  if (user?.role === 'SUPERADMIN') {
    navItems.push({ icon: Settings, label: 'Admin', path: '/admin', count: 0 });
  }

  return (
    <>
      <InputDialog
        isOpen={isNewNotebookOpen}
        onClose={() => setIsNewNotebookOpen(false)}
        onConfirm={async (name) => {
          if (name) {
            try {
              await createNotebook(name);
              toast.success(t('notebooks.created'));
            } catch (error: unknown) {
              toast.error(error instanceof Error ? error.message : t('notebooks.createFailed'));
            }
          }
        }}
        title={t('notebooks.create')}
        placeholder={t('notebooks.namePlaceholder')}
        confirmText={t('common.create')}
      />

      <DeleteConfirmationDialog
        isOpen={!!deleteNotebookId}
        onClose={() => setDeleteNotebookId(null)}
        onConfirm={handleDeleteNotebook}
        itemName={deleteNotebookName}
        title={t('notebooks.deleteTitle')}
        description={t('notebooks.deleteDescription')}
      />

      <ConfirmDialog
        isOpen={isEmptyTrashConfirmOpen}
        onClose={() => setIsEmptyTrashConfirmOpen(false)}
        onConfirm={confirmEmptyTrash}
        title={t('trash.emptyTrashTitle', 'Empty Trash')}
        message={t('trash.emptyConfirm')}
        confirmText={t('trash.emptyTrash')}
        variant="danger"
      />

      <NotebookSharingModal
        isOpen={!!sharingNotebookId}
        onClose={() => setSharingNotebookId(null)}
        notebookId={sharingNotebookId || ''}
        notebookName={notebooks?.find(n => n.id === sharingNotebookId)?.name || ''}
      />

      <SharedUsersModal
        isOpen={!!viewSharesNotebookId}
        onClose={() => setViewSharesNotebookId(null)}
        users={
          viewSharesNotebookId && notebookShareCounts?.[viewSharesNotebookId]
            ? notebookShareCounts[viewSharesNotebookId].users.map((s): SharedUserInfo => ({
                id: s.user.id,
                name: s.user.name,
                email: s.user.email,
                avatarUrl: s.user.avatarUrl,
                permission: s.permission,
              }))
            : []
        }
        currentUserId={user?.id}
        owner={user ? { id: user.id, name: user.name || null, email: user.email, avatarUrl: user.avatarUrl } : null}
      />

      <div className="flex h-full flex-col overflow-hidden bg-neutral-50 border-r border-neutral-200/60 text-neutral-700 dark:bg-neutral-950 dark:border-neutral-800/40 dark:text-neutral-300">
        {/* Hidden file inputs — always rendered */}
        {hiddenInput}
        {notebookPickerModal}
        {hiddenInputOneNote}
        {notebookPickerModalOneNote}

        {/* ── Collapsed Icon Rail (desktop only) ── */}
        {!isMobile && isSidebarCollapsed ? (
          <div className="flex flex-col items-center h-full py-3 gap-1">
            {/* Avatar */}
            <Link
              to="/profile"
              className="flex items-center justify-center w-9 h-9 rounded-full bg-emerald-600 flex-shrink-0 hover:ring-2 hover:ring-emerald-400 transition-all"
              title={user?.name || user?.email || ''}
            >
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                  alt={t('common.profileAlt')}
                  className="w-full h-full rounded-full object-cover"
                />
              ) : (
                <span className="text-white font-bold text-sm">
                  {user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'}
                </span>
              )}
            </Link>

            {/* New Note */}
            <button
              onClick={handleCreateNote}
              className="mt-1 flex items-center justify-center w-9 h-9 rounded-full bg-gradient-to-b from-emerald-500 to-emerald-600 shadow-sm shadow-emerald-600/25 text-white hover:from-emerald-600 hover:to-emerald-700 hover:shadow-md transition-all flex-shrink-0"
              title={t('sidebar.newNote')}
              aria-label={t('sidebar.newNote')}
            >
              <Plus size={18} />
            </button>

            <div className="w-6 border-t border-neutral-200/60 dark:border-neutral-700 my-1" />

            {/* Nav icons */}
            <div className="flex-1 flex flex-col items-center gap-0.5 overflow-y-auto w-full px-1.5">
              {navItems.map((item) => {
                const isActive = location.pathname === item.path || (item.path === '/notes' && location.pathname === '/');
                return (
                  <Link
                    key={item.path}
                    to={item.path}
                    className={clsx(
                      'relative flex items-center justify-center w-9 h-9 rounded-lg transition-colors flex-shrink-0',
                      isActive
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                        : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white'
                    )}
                    title={item.label}
                    aria-label={item.label}
                  >
                    <item.icon size={18} />
                    {(item.count ?? 0) > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center text-[10px] font-bold bg-red-500 text-white rounded-full px-1">
                        {item.count}
                      </span>
                    )}
                  </Link>
                );
              })}

              {/* Search */}
              <button
                onClick={openSearch}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white transition-colors flex-shrink-0"
                title={t('sidebar.search')}
                aria-label={t('sidebar.search')}
              >
                <Search size={18} />
              </button>
            </div>

            <div className="w-6 border-t border-neutral-200/60 dark:border-neutral-700 my-1" />

            {/* Footer actions */}
            <div className="flex flex-col items-center gap-0.5">
              <NotificationDropdown />
              <button
                onClick={toggleTheme}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                title={t('common.theme')}
                aria-label={t('sidebar.toggleTheme')}
              >
                {getThemeIcon()}
              </button>
              <Link
                to="/settings"
                className="flex items-center justify-center w-9 h-9 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                title={t('sidebar.settings')}
                aria-label={t('sidebar.settings')}
              >
                <Settings size={18} />
              </Link>
              <button
                onClick={logout}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-neutral-500 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                title={t('auth.logout')}
                aria-label={t('auth.logout')}
              >
                <LogOut size={18} />
              </button>
              {/* Expand button */}
              <button
                onClick={toggleSidebarCollapsed}
                className="flex items-center justify-center w-9 h-9 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 transition-colors"
                title={t('sidebar.expandSidebar')}
                aria-label={t('sidebar.expandSidebar')}
              >
                <PanelLeftOpen size={18} />
              </button>
            </div>
          </div>
        ) : (
          /* ── Full Expanded Sidebar ── */
          <>
            {/* User Profile */}
            <div className="p-4 border-b border-neutral-200/60 dark:border-neutral-800/40">
              <div className="flex items-center gap-2">
                <Link to="/profile" className="flex items-center gap-3 hover:bg-neutral-100 dark:hover:bg-neutral-800 p-2 rounded-lg transition-colors flex-1 min-w-0">
                  <div className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white font-bold flex-shrink-0">
                    {user?.avatarUrl ? (
                      <img
                        src={user.avatarUrl.replace(/^https?:\/\/localhost:\d+/, '')}
                        alt={t('common.profileAlt')}
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate text-neutral-900 dark:text-white">
                      {user?.name || user?.email?.split('@')[0]}
                    </p>
                    <p className="text-xs text-neutral-500 truncate dark:text-neutral-400">{user?.email}</p>
                  </div>
                  {!isMobile && <UserPen size={16} className="text-neutral-400 flex-shrink-0" />}
                </Link>
                {isMobile ? (
                  <button
                    onClick={closeSidebar}
                    aria-label={t('common.close')}
                    className="p-2 rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200 transition-colors flex-shrink-0"
                  >
                    <PanelLeftClose size={20} />
                  </button>
                ) : (
                  <button
                    onClick={toggleSidebarCollapsed}
                    className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-400 dark:hover:text-neutral-300 transition-colors flex-shrink-0"
                    title={t('sidebar.collapseSidebar')}
                    aria-label={t('sidebar.collapseSidebar')}
                  >
                    <PanelLeftClose size={18} />
                  </button>
                )}
              </div>
            </div>

            {/* Create Note Button */}
            <div className="p-4">
              <button
                onClick={handleCreateNote}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-gradient-to-b from-emerald-500 to-emerald-600 shadow-sm shadow-emerald-600/25 py-2 px-4 text-sm font-medium text-white hover:from-emerald-600 hover:to-emerald-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 transition-all"
              >
                <Plus size={18} />
                {t('sidebar.newNote')}
              </button>
            </div>

            {/* Navigation */}
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-6">
              <div className="space-y-1">
                {navItems.map((item) => {
                  const isActive = location.pathname === item.path || (item.path === '/notes' && location.pathname === '/');
                  const hasOverlay = item.path === '/trash' && trashCount > 0;
                  return (
                    <div
                      key={item.path}
                      className={clsx(
                        'group/nav relative overflow-hidden flex items-center rounded-md transition-colors',
                        isActive
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                          : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white'
                      )}
                    >
                      <Link
                        to={item.path}
                        data-testid={`sidebar-item-${item.path === '/' ? 'home' : item.path.substring(1)}`}
                        className="flex-1 flex items-center gap-3 px-3 py-2 text-sm font-medium"
                      >
                        <item.icon size={18} className="flex-shrink-0" />
                        <span className="flex-1 truncate">{item.label}</span>
                        {(item.count ?? 0) > 0 && (
                          <span className="flex-shrink-0 text-xs text-neutral-400 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded-full">
                            {item.count}
                          </span>
                        )}
                      </Link>
                      {hasOverlay && (
                        <div className={clsx(
                          "absolute right-0 top-0 bottom-0 z-10 flex items-center pl-6 pr-2 opacity-0 group-hover/nav:opacity-100 transition-opacity",
                          isActive
                            ? "bg-gradient-to-l from-emerald-50 via-emerald-50 to-transparent dark:from-emerald-900/20 dark:via-emerald-900/20 dark:to-transparent"
                            : "bg-gradient-to-l from-neutral-100 via-neutral-100 to-transparent dark:from-neutral-800 dark:via-neutral-800 dark:to-transparent"
                        )}>
                          <button
                            onClick={() => setIsEmptyTrashConfirmOpen(true)}
                            className="text-neutral-400 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors"
                            title={t('trash.emptyTrash')}
                            aria-label={t('trash.emptyTrash')}
                          >
                            <XCircle size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

                <button
                  onClick={openSearch}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white transition-colors"
                >
                  <Search size={18} className="flex-shrink-0" />
                  {t('sidebar.search')}
                </button>
              </div>

              {/* Pinned Notes */}
              {pinnedNotes && pinnedNotes.length > 0 && (
                <div className="space-y-1">
                  <div className="px-3 text-xs font-semibold text-neutral-500 uppercase tracking-widest dark:text-neutral-400">
                    {t('sidebar.shortcuts')}
                  </div>
                  {pinnedNotes.map(note => (
                    <Link
                      key={note.id}
                      to={`/notes?noteId=${note.id}`}
                      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white truncate"
                    >
                      <Star size={14} className="flex-shrink-0 text-yellow-500" />
                      <span className="truncate">{note.title || t('notes.untitled')}</span>
                    </Link>
                  ))}
                </div>
              )}

              {/* Notebooks */}
              <div className="space-y-1">
                <div className="flex items-center justify-between px-3 group">
                  <button
                    onClick={() => setIsNotebooksOpen(!isNotebooksOpen)}
                    className="flex items-center gap-2 text-xs font-semibold text-neutral-500 uppercase tracking-widest hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-300"
                  >
                    {isNotebooksOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {t('sidebar.notebooks')}
                  </button>
                  <button
                    onClick={() => setIsNewNotebookOpen(true)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-neutral-200 rounded dark:hover:bg-neutral-700 transition-all"
                    title={t('notebooks.create')}
                    aria-label={t('notebooks.create')}
                  >
                    <Plus size={14} />
                  </button>
                </div>

                {isNotebooksOpen && (
                  <div className="space-y-0.5 mt-1">
                    {notebooks?.map((notebook) => (
                      <div
                        key={notebook.id}
                        className={clsx(
                          'group relative flex items-center px-3 py-2 rounded-md text-sm transition-colors overflow-hidden',
                          searchParams.get('notebookId') === notebook.id
                            ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-300'
                            : 'text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white'
                        )}
                      >
                        {renamingNotebookId === notebook.id ? (
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <Book size={16} className="flex-shrink-0" />
                            <input
                              ref={renameInputRef}
                              value={renameText}
                              onChange={(e) => setRenameText(e.target.value)}
                              onBlur={handleRenameSubmit}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRenameSubmit();
                                if (e.key === 'Escape') handleRenameCancel();
                              }}
                              className="flex-1 min-w-0 bg-transparent border-b-2 border-emerald-500 text-sm text-neutral-900 dark:text-white outline-none py-0"
                            />
                          </div>
                        ) : (
                          <>
                            <Link
                              to={`/notes?notebookId=${notebook.id}`}
                              className="flex items-center gap-3 flex-1 min-w-0"
                              onDoubleClick={(e) => {
                                if (notebook.userId === user?.id) {
                                  e.preventDefault();
                                  startRename(notebook.id, notebook.name);
                                }
                              }}
                              onTouchStart={() => {
                                if (notebook.userId !== user?.id) return;
                                longPressTimerRef.current = setTimeout(() => {
                                  startRename(notebook.id, notebook.name);
                                }, 600);
                              }}
                              onTouchEnd={() => {
                                if (longPressTimerRef.current) {
                                  clearTimeout(longPressTimerRef.current);
                                  longPressTimerRef.current = null;
                                }
                              }}
                              onTouchMove={() => {
                                if (longPressTimerRef.current) {
                                  clearTimeout(longPressTimerRef.current);
                                  longPressTimerRef.current = null;
                                }
                              }}
                            >
                              <Book size={16} className="flex-shrink-0" />
                              <span className="truncate">{notebook.name}</span>
                              <span className="ml-auto flex-shrink-0 text-xs text-neutral-400 dark:text-neutral-400 bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 rounded-full">
                                {'count' in notebook ? (notebook as { count: number }).count : 0}
                              </span>
                              {notebookShareCounts && notebookShareCounts[notebook.id] && (
                                <button
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); setViewSharesNotebookId(notebook.id); }}
                                  className="flex-shrink-0 flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors"
                                  title={t('sharing.sharedWithCount', { count: notebookShareCounts[notebook.id].count })}
                                >
                                  <Users size={12} />
                                  <span className="text-[10px] font-medium">{notebookShareCounts[notebook.id].count}</span>
                                </button>
                              )}
                            </Link>
                            {notebook.userId === user?.id && (
                              <div className={clsx(
                                'absolute right-0 top-0 bottom-0 z-10 flex items-center gap-0.5 pl-6 pr-2 opacity-0 group-hover:opacity-100 transition-opacity',
                                searchParams.get('notebookId') === notebook.id
                                  ? 'bg-gradient-to-l from-emerald-50 via-emerald-50 to-transparent dark:from-emerald-900/20 dark:via-emerald-900/20 dark:to-transparent'
                                  : 'bg-gradient-to-l from-neutral-100 via-neutral-100 to-transparent dark:from-neutral-800 dark:via-neutral-800 dark:to-transparent'
                              )}>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    startRename(notebook.id, notebook.name);
                                  }}
                                  className="p-1 text-neutral-400 hover:text-emerald-600 dark:text-neutral-400 dark:hover:text-emerald-400 transition-colors"
                                  title={t('common.rename')}
                                  aria-label={t('common.rename')}
                                >
                                  <Pencil size={14} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setSharingNotebookId(notebook.id);
                                  }}
                                  className="p-1 text-neutral-400 hover:text-emerald-600 dark:text-neutral-400 dark:hover:text-emerald-400 transition-colors"
                                  title={t('sharing.share')}
                                  aria-label={t('sharing.share')}
                                >
                                  <Share2 size={14} />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.preventDefault();
                                    setDeleteNotebookId(notebook.id);
                                    setDeleteNotebookName(notebook.name);
                                  }}
                                  className="p-1 text-neutral-400 hover:text-red-500 dark:text-neutral-400 dark:hover:text-red-400 transition-colors"
                                  title={t('common.delete')}
                                  aria-label={t('common.delete')}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Tags */}
              <div className="space-y-1">
                <div className="flex items-center justify-between px-3 group">
                  <button
                    onClick={() => setIsTagsOpen(!isTagsOpen)}
                    className="flex items-center gap-2 text-xs font-semibold text-neutral-500 uppercase tracking-widest hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-300"
                  >
                    {isTagsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {t('sidebar.tags')}
                  </button>
                  <button
                    onClick={() => setIsNewTagOpen(true)}
                    className="opacity-0 group-hover:opacity-100 p-1 hover:bg-neutral-200 rounded dark:hover:bg-neutral-700 transition-all"
                    title={t('tags.addTag')}
                    aria-label={t('tags.addTag')}
                  >
                    <Plus size={14} />
                  </button>
                </div>

                {isTagsOpen && (
                  <TagList
                    selectedTagId={selectedTagId}
                    onSelectTag={handleSelectTag}
                    hideHeader={true}
                    isCreatingExternal={isNewTagOpen}
                    onCancelCreate={() => setIsNewTagOpen(false)}
                    isVault={location.pathname.startsWith('/vault')}
                  />
                )}
              </div>

              {/* External Sources */}
              <div className="space-y-1">
                <div className="px-3 text-xs font-semibold text-neutral-500 uppercase tracking-widest dark:text-neutral-400">
                  {t('sidebar.externalSources')}
                </div>
                <button
                  onClick={() => importFile()}
                  disabled={isUploading}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white transition-colors disabled:opacity-50"
                >
                  <svg width="16" height="16" viewBox="0 0 32 32" fill="#7fce2c" className="flex-shrink-0">
                    <path d="M29.343 16.818c.1 1.695-.08 3.368-.305 5.045-.225 1.712-.508 3.416-.964 5.084-.3 1.067-.673 2.1-1.202 3.074-.65 1.192-1.635 1.87-2.992 1.924l-3.832.036c-.636-.017-1.278-.146-1.9-.297-1.192-.3-1.862-1.1-2.06-2.3-.186-1.08-.173-2.187.04-3.264.252-1.23 1-1.96 2.234-2.103.817-.1 1.65-.077 2.476-.1.205-.007.275.098.203.287-.196.53-.236 1.07-.098 1.623.053.207-.023.307-.26.305a7.77 7.77 0 0 0-1.123.053c-.636.086-.96.47-.96 1.112 0 .205.026.416.066.622.103.507.45.78.944.837 1.123.127 2.247.138 3.37-.05.675-.114 1.08-.54 1.16-1.208.152-1.3.155-2.587-.228-3.845-.33-1.092-1.006-1.565-2.134-1.7l-3.36-.54c-1.06-.193-1.7-.887-1.92-1.9-.13-.572-.14-1.17-.214-1.757-.013-.106-.074-.208-.1-.3-.04.1-.106.212-.117.326-.066.68-.053 1.373-.185 2.04-.16.8-.404 1.566-.67 2.33-.185.535-.616.837-1.205.8a37.76 37.76 0 0 1-7.123-1.353l-.64-.207c-.927-.26-1.487-.903-1.74-1.787l-1-3.853-.74-4.3c-.115-.755-.2-1.523-.083-2.293.154-1.112.914-1.903 2.04-1.964l3.558-.062c.127 0 .254.003.373-.026a1.23 1.23 0 0 0 1.01-1.255l-.05-3.036c-.048-1.576.8-2.38 2.156-2.622a10.58 10.58 0 0 1 4.91.26c.933.275 1.467.923 1.715 1.83.058.22.146.3.37.287l2.582.01 3.333.37c.686.095 1.364.25 2.032.42 1.165.298 1.793 1.112 1.962 2.256l.357 3.355.3 5.577.01 2.277zm-4.534-1.155c-.02-.666-.07-1.267-.444-1.784a1.66 1.66 0 0 0-2.469-.15c-.364.4-.494.88-.564 1.4-.008.034.106.126.16.126l.8-.053c.768.007 1.523.113 2.25.393.066.026.136.04.265.077zM8.787 1.154a3.82 3.82 0 0 0-.278 1.592l.05 2.934c.005.357-.075.45-.433.45L5.1 6.156c-.583 0-1.143.1-1.554.278l5.2-5.332c.02.013.04.033.06.053z"/>
                  </svg>
                  <span>{t('sidebar.importEvernote')}</span>
                </button>
                <button
                  onClick={() => importFileOneNote()}
                  disabled={isUploadingOneNote}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white transition-colors disabled:opacity-50"
                >
                  <img src="/oneNote.png" alt="OneNote" width="16" height="16" className="flex-shrink-0" />
                  <span>{t('sidebar.importOneNote')}</span>
                </button>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-neutral-200/60 dark:border-neutral-800/40 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <img src="/favicon.png" alt={t('common.logoAlt')} className="h-6 w-6 object-contain" />
                <div className="flex flex-col">
                  <span className="text-xs font-bold text-neutral-900 dark:text-white leading-none">{t('common.notiq')}</span>
                  <span className="text-[10px] text-neutral-500 dark:text-neutral-400 leading-none mt-0.5">v{CURRENT_VERSION}</span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <NotificationDropdown />
                <button
                  onClick={toggleTheme}
                  className="p-2 text-neutral-500 hover:bg-neutral-100 rounded-lg dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                  title={t('common.theme')}
                  aria-label={t('sidebar.toggleTheme')}
                >
                  {getThemeIcon()}
                </button>
                <Link
                  to="/settings"
                  className="p-2 text-neutral-500 hover:bg-neutral-100 rounded-lg dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                  title={t('sidebar.settings')}
                  aria-label={t('sidebar.settings')}
                >
                  <Settings size={18} />
                </Link>
                <button
                  onClick={logout}
                  className="p-2 text-neutral-500 hover:bg-neutral-100 rounded-lg dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors"
                  title={t('auth.logout')}
                  aria-label={t('auth.logout')}
                >
                  <LogOut size={18} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
