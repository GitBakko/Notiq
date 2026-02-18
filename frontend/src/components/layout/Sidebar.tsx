import { useState } from 'react';
import { Plus, Search, Settings, ChevronRight, ChevronDown, Book, Trash2, LogOut, Moon, Sun, Monitor, Star, Lock, Share2, Users, Orbit, Home, FileText, CheckSquare } from 'lucide-react';
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
import { useImport } from '../../hooks/useImport';
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
  const { isUploading, importFile, hiddenInput } = useImport();

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
                  alt={t('common.profileAlt')}
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
                isVault={location.pathname.startsWith('/vault')}
              />
            )}
          </div>

          {/* External Sources */}
          <div className="space-y-1">
            <div className="px-3 text-xs font-semibold text-gray-500 uppercase tracking-wider dark:text-gray-500">
              {t('sidebar.externalSources')}
            </div>
            <button
              onClick={() => importFile()}
              disabled={isUploading}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-white transition-colors disabled:opacity-50"
            >
              <svg width="16" height="16" viewBox="0 0 32 32" fill="#7fce2c" className="flex-shrink-0">
                <path d="M29.343 16.818c.1 1.695-.08 3.368-.305 5.045-.225 1.712-.508 3.416-.964 5.084-.3 1.067-.673 2.1-1.202 3.074-.65 1.192-1.635 1.87-2.992 1.924l-3.832.036c-.636-.017-1.278-.146-1.9-.297-1.192-.3-1.862-1.1-2.06-2.3-.186-1.08-.173-2.187.04-3.264.252-1.23 1-1.96 2.234-2.103.817-.1 1.65-.077 2.476-.1.205-.007.275.098.203.287-.196.53-.236 1.07-.098 1.623.053.207-.023.307-.26.305a7.77 7.77 0 0 0-1.123.053c-.636.086-.96.47-.96 1.112 0 .205.026.416.066.622.103.507.45.78.944.837 1.123.127 2.247.138 3.37-.05.675-.114 1.08-.54 1.16-1.208.152-1.3.155-2.587-.228-3.845-.33-1.092-1.006-1.565-2.134-1.7l-3.36-.54c-1.06-.193-1.7-.887-1.92-1.9-.13-.572-.14-1.17-.214-1.757-.013-.106-.074-.208-.1-.3-.04.1-.106.212-.117.326-.066.68-.053 1.373-.185 2.04-.16.8-.404 1.566-.67 2.33-.185.535-.616.837-1.205.8a37.76 37.76 0 0 1-7.123-1.353l-.64-.207c-.927-.26-1.487-.903-1.74-1.787l-1-3.853-.74-4.3c-.115-.755-.2-1.523-.083-2.293.154-1.112.914-1.903 2.04-1.964l3.558-.062c.127 0 .254.003.373-.026a1.23 1.23 0 0 0 1.01-1.255l-.05-3.036c-.048-1.576.8-2.38 2.156-2.622a10.58 10.58 0 0 1 4.91.26c.933.275 1.467.923 1.715 1.83.058.22.146.3.37.287l2.582.01 3.333.37c.686.095 1.364.25 2.032.42 1.165.298 1.793 1.112 1.962 2.256l.357 3.355.3 5.577.01 2.277zm-4.534-1.155c-.02-.666-.07-1.267-.444-1.784a1.66 1.66 0 0 0-2.469-.15c-.364.4-.494.88-.564 1.4-.008.034.106.126.16.126l.8-.053c.768.007 1.523.113 2.25.393.066.026.136.04.265.077zM8.787 1.154a3.82 3.82 0 0 0-.278 1.592l.05 2.934c.005.357-.075.45-.433.45L5.1 6.156c-.583 0-1.143.1-1.554.278l5.2-5.332c.02.013.04.033.06.053z"/>
              </svg>
              <span>{t('sidebar.importEvernote')}</span>
            </button>
            {hiddenInput}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <img src="/favicon.png" alt={t('common.logoAlt')} className="h-6 w-6 object-contain" />
            <div className="flex flex-col">
              <span className="text-xs font-bold text-gray-900 dark:text-white leading-none">{t('common.notiq')}</span>
              <span className="text-[10px] text-gray-500 dark:text-gray-400 leading-none mt-0.5">{t('common.versionShort')}</span>
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
