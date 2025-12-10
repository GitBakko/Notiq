import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, FileText, Book, Menu } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getSharedNotes } from '../notes/noteService';
import { getSharedNotebooks } from '../notebooks/notebookService';
import clsx from 'clsx';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';

interface SharedNote {
  id: string;
  noteId: string;
  userId: string;
  permission: 'READ' | 'WRITE';
  note: {
    id: string;
    title: string;
    updatedAt: string;
    user: {
      name: string | null;
      email: string;
    };
  };
}

interface SharedNotebook {
  id: string;
  notebookId: string;
  userId: string;
  permission: 'READ' | 'WRITE';
  notebook: {
    id: string;
    name: string;
    updatedAt: string;
    user: {
      name: string | null;
      email: string;
    };
  };
}

export default function SharedWithMePage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'notes' | 'notebooks'>('notes');
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([]);
  const [sharedNotebooks, setSharedNotebooks] = useState<SharedNotebook[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  useEffect(() => {
    const fetchData = async () => {
      setIsLoading(true);
      try {
        const [notes, notebooks] = await Promise.all([
          getSharedNotes(),
          getSharedNotebooks()
        ]);
        setSharedNotes(notes);
        setSharedNotebooks(notebooks);
      } catch (error) {
        console.error('Failed to fetch shared items', error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchData();
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full bg-white dark:bg-gray-900">
      <div className="p-6 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3">
          {isMobile && (
            <button onClick={toggleSidebar} className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200">
              <Menu size={24} />
            </button>
          )}
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            <Users className="text-emerald-600" />
            {t('sharing.sharedWithMe')}
          </h1>
        </div>
        <p className="text-gray-500 mt-1 dark:text-gray-400">{t('sharing.sharedWithMeSubtitle')}</p>
      </div>

      <div className="flex border-b border-gray-200 dark:border-gray-800">
        <button
          onClick={() => setActiveTab('notes')}
          className={clsx(
            "px-6 py-3 text-sm font-medium border-b-2 transition-colors",
            activeTab === 'notes'
              ? "border-emerald-600 text-emerald-600 dark:text-emerald-500"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          )}
        >
          {t('sidebar.notes')} ({sharedNotes.length})
        </button>
        <button
          onClick={() => setActiveTab('notebooks')}
          className={clsx(
            "px-6 py-3 text-sm font-medium border-b-2 transition-colors",
            activeTab === 'notebooks'
              ? "border-emerald-600 text-emerald-600 dark:text-emerald-500"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          )}
        >
          {t('sidebar.notebooks')} ({sharedNotebooks.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            {t('common.loading')}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeTab === 'notes' ? (
              sharedNotes.length === 0 ? (
                <div className="col-span-full text-center text-gray-500 py-12">
                  {t('sharing.noSharedNotes')}
                </div>
              ) : (
                sharedNotes.map(item => (
                  <Link
                    key={item.id}
                    to={`/notes?noteId=${item.note.id}`}
                    className="block p-4 rounded-xl border border-gray-200 hover:border-emerald-500 hover:shadow-md transition-all bg-white dark:bg-gray-800 dark:border-gray-700 dark:hover:border-emerald-500"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <FileText className="text-gray-400 dark:text-gray-500" size={20} />
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {item.permission}
                      </span>
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-1 truncate dark:text-white">{item.note.title || t('notes.untitled')}</h3>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 flex items-center gap-1">
                      <span>{t('sharing.sharedBy')}</span>
                      <span className="font-medium text-gray-700 dark:text-gray-300">{item.note.user.name || item.note.user.email}</span>
                    </div>
                  </Link>
                ))
              )
            ) : (
              sharedNotebooks.length === 0 ? (
                <div className="col-span-full text-center text-gray-500 py-12">
                  {t('sharing.noSharedNotebooks')}
                </div>
              ) : (
                sharedNotebooks.map(item => (
                  <Link
                    key={item.id}
                    to={`/notes?notebookId=${item.notebook.id}`}
                    className="block p-4 rounded-xl border border-gray-200 hover:border-emerald-500 hover:shadow-md transition-all bg-white dark:bg-gray-800 dark:border-gray-700 dark:hover:border-emerald-500"
                  >
                    <div className="flex items-start justify-between mb-2">
                      <Book className="text-gray-400 dark:text-gray-500" size={20} />
                      <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                        {item.permission}
                      </span>
                    </div>
                    <h3 className="font-semibold text-gray-900 mb-1 truncate dark:text-white">{item.notebook.name}</h3>
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 flex items-center gap-1">
                      <span>{t('sharing.sharedBy')}</span>
                      <span className="font-medium text-gray-700 dark:text-gray-300">{item.notebook.user.name || item.notebook.user.email}</span>
                    </div>
                  </Link>
                ))
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}
