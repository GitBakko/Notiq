import { useState } from 'react';
import { Plus, Search, Settings, ChevronRight, ChevronDown, Book, Trash2, LogOut, Moon, Sun, Monitor, Star, Lock, Share2, Users, Home, FileText, CheckSquare } from 'lucide-react';
import { useLocation, Link, useNavigate, useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import { useNotebooks } from '../../hooks/useNotebooks';
import { useNotes } from '../../hooks/useNotes';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '../../store/authStore';
import { useUIStore } from '../../store/uiStore';
import { InputDialog } from '../ui/InputDialog';
import { DeleteConfirmationDialog } from '../ui/DeleteConfirmationDialog';
import { createNotebook, deleteNotebook } from '../../features/notebooks/notebookService';
import { createNote } from '../../features/notes/noteService';
import TagList from '../../features/tags/TagList';
import { usePinnedNotes } from '../../hooks/usePinnedNotes';
import NotebookSharingModal from '../sharing/NotebookSharingModal';
import toast from 'react-hot-toast';
import NotificationDropdown from '../../features/notifications/NotificationDropdown';

export default function Sidebar() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const selectedTagId = searchParams.get('tagId') || undefined;

  const { user, logout } = useAuthStore();
  const { theme, setTheme, openSearch } = useUIStore();
  const [isNotebooksOpen, setIsNotebooksOpen] = useState(true);
  const [isNewNotebookOpen, setIsNewNotebookOpen] = useState(false);
  const [isTagsOpen, setIsTagsOpen] = useState(true);
  const [isNewTagOpen, setIsNewTagOpen] = useState(false);
  const [sharingNotebookId, setSharingNotebookId] = useState<string | null>(null);

  const [deleteNotebookId, setDeleteNotebookId] = useState<string | null>(null);
  const [deleteNotebookName, setDeleteNotebookName] = useState('');

  const { notebooks } = useNotebooks();
  const pinnedNotes = usePinnedNotes();

  const handleCreateNote = async () => {
    console.log('Sidebar: handleCreateNote called');
    let defaultNotebookId: string;

    if (!notebooks || notebooks.length === 0) {
      console.log('Sidebar: No notebooks found, creating default...');
      try {
        const nb = await createNotebook(t('notebooks.firstNotebook'));
        defaultNotebookId = nb.id;
        console.log('Sidebar: Default notebook created', defaultNotebookId);
      } catch (e) {
        console.error('Sidebar: Failed to create default notebook', e);
        return;
      }
    } else {
      defaultNotebookId = notebooks[0].id;
      console.log('Sidebar: Using existing notebook', defaultNotebookId);
    }

    try {
      console.log('Sidebar: Creating note...');
      const newNote = await createNote({
        title: '',
        notebookId: defaultNotebookId,
        content: ''
      });
      console.log('Sidebar: Note created', newNote.id);
      navigate(`/notes?noteId=${newNote.id}`);
      console.log('Sidebar: Navigated to note');
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
    } catch (error) {
      toast.error(t('notebooks.deleteFailed'));
    }
  };



  // We need a specific query for trash count across all notebooks
  const trashedNotes = useNotes(undefined, undefined, undefined, true);
  const trashCount = trashedNotes?.length || 0;

  const navItems = [
    { icon: Home, label: t('sidebar.home'), path: '/' },
    { icon: FileText, label: t('sidebar.notes'), path: '/notes' },
    { icon: CheckSquare, label: t('sidebar.tasks'), path: '/tasks' },
    // Notebooks is handled separately
    { icon: Users, label: t('sharing.sharedWithMe'), path: '/shared' },
    { icon: Lock, label: t('vault.title'), path: '/vault' },
    { icon: Trash2, label: t('sidebar.trash'), path: '/trash', count: trashCount },
  ];

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
            } catch (error: any) {
              toast.error(error.message || t('notebooks.createFailed'));
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

      <NotebookSharingModal
        isOpen={!!sharingNotebookId}
        onClose={() => setSharingNotebookId(null)}
        notebookId={sharingNotebookId || ''}
        notebookName={notebooks?.find(n => n.id === sharingNotebookId)?.name || ''}
      />

      <div className="flex h-full w-64 flex-col bg-gray-50 border-r border-gray-200 text-gray-700 dark:bg-gray-900 dark:border-gray-800 dark:text-gray-300">
        {/* User Profile */}
        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
          <Link to="/profile" className="flex items-center gap-3 hover:bg-gray-100 dark:hover:bg-gray-800 p-2 rounded-lg transition-colors">
            <div className="h-8 w-8 rounded-full bg-emerald-600 flex items-center justify-center text-white font-bold">
              {user?.avatarUrl ? (
                <img
                  src={user.avatarUrl.startsWith('http://localhost:3001') ? user.avatarUrl.replace('http://localhost:3001', '') : user.avatarUrl}
                  alt="Profile"
                  className="w-full h-full rounded-full object-cover"
                />
              ) : (
                user?.name?.[0]?.toUpperCase() || user?.email?.[0]?.toUpperCase() || 'U'
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate text-gray-900 dark:text-white">
                {user?.name || user?.email?.split('@')[0]}
              </p>
              <p className="text-xs text-gray-500 truncate dark:text-gray-400">{user?.email}</p>
            </div>
            <Settings size={16} className="text-gray-400" />
          </Link>
        </div>

        {/* Create Note Button */}
        <div className="p-4">
          <button
            onClick={handleCreateNote}
            className="flex w-full items-center justify-center gap-2 rounded-full bg-emerald-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 transition-all"
          >
            <Plus size={18} />
            {t('sidebar.newNote')}
          </button>
        </div>

        {/* Navigation */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-6">
          <div className="space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.path}
                to={item.path}
                data-testid={`sidebar-item-${item.path === '/' ? 'home' : item.path.substring(1)}`}
                className={clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors',
                  location.pathname === item.path
                    ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-white'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'
                )}
              >
                <item.icon size={18} />
                <span className="flex-1">{item.label}</span>
                {(item as any).count > 0 && (
                  <span className="text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                    {(item as any).count}
                  </span>
                )}
              </Link>
            ))}

            <button
              onClick={openSearch}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white transition-colors"
            >
              <Search size={18} />
              {t('sidebar.search')}
            </button>
          </div>

          {/* Pinned Notes */}
          {pinnedNotes && pinnedNotes.length > 0 && (
            <div className="space-y-1">
              <div className="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-500">
                {t('sidebar.shortcuts')}
              </div>
              {pinnedNotes.map(note => (
                <Link
                  key={note.id}
                  to={`/notes?noteId=${note.id}`}
                  className="flex items-center gap-3 px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white truncate"
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
                className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-900 dark:text-gray-500 dark:hover:text-gray-300"
              >
                {isNotebooksOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t('sidebar.notebooks')}
              </button>
              <button
                onClick={() => setIsNewNotebookOpen(true)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 rounded dark:hover:bg-gray-700 transition-all"
                title={t('notebooks.create')}
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
                      'group flex items-center justify-between px-3 py-2 rounded-md text-sm transition-colors',
                      searchParams.get('notebookId') === notebook.id
                        ? 'bg-gray-200 text-gray-900 dark:bg-gray-800 dark:text-white'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white'
                    )}
                  >
                    <Link
                      to={`/notes?notebookId=${notebook.id}`}
                      className="flex items-center gap-3 flex-1 min-w-0"
                    >
                      <Book size={16} className="flex-shrink-0" />
                      <span className="truncate">{notebook.name}</span>
                      <span className="ml-auto text-xs text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800 px-2 py-0.5 rounded-full">
                        {(notebook as any).count || 0}
                      </span>
                    </Link>
                    <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                      {notebook.userId === user?.id && (
                        <>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              setSharingNotebookId(notebook.id);
                            }}
                            className="p-1 hover:text-emerald-600 transition-colors"
                            title={t('sharing.share')}
                          >
                            <Share2 size={14} />
                          </button>
                          <button
                            onClick={(e) => {
                              e.preventDefault();
                              setDeleteNotebookId(notebook.id);
                              setDeleteNotebookName(notebook.name);
                            }}
                            className="p-1 hover:text-red-600 transition-colors"
                            title={t('common.delete')}
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Tags */}
          {/* Tags */}
          <div className="space-y-1">
            <div className="flex items-center justify-between px-3 group">
              <button
                onClick={() => setIsTagsOpen(!isTagsOpen)}
                className="flex items-center gap-2 text-xs font-semibold text-gray-500 uppercase tracking-wider hover:text-gray-900 dark:text-gray-500 dark:hover:text-gray-300"
              >
                {isTagsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {t('sidebar.tags')}
              </button>
              <button
                onClick={() => setIsNewTagOpen(true)}
                className="opacity-0 group-hover:opacity-100 p-1 hover:bg-gray-200 rounded dark:hover:bg-gray-700 transition-all"
                title={t('tags.addTag')}
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
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/favicon.png" alt="Notiq" className="h-6 w-6 object-contain" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-gray-900 dark:text-white leading-none">Notiq</span>
              <span className="text-[10px] text-gray-500 dark:text-gray-400 leading-none mt-0.5">v0.1.0</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <NotificationDropdown />
            <button
              onClick={toggleTheme}
              className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
              title={t('common.theme')}
            >
              {getThemeIcon()}
            </button>
            <button
              onClick={logout}
              className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg dark:text-gray-400 dark:hover:bg-gray-800 transition-colors"
              title={t('auth.logout')}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
