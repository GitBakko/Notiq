import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, FileText, Book, Menu, ListChecks, Columns3 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { getSharedNotes } from '../notes/noteService';
import { getSharedNotebooks } from '../notebooks/notebookService';
import clsx from 'clsx';
import { useIsMobile } from '../../hooks/useIsMobile';
import api from '../../lib/api';
import { useUIStore } from '../../store/uiStore';
import { useAuthStore } from '../../store/authStore';

interface SharedNote {
  id: string;
  noteId: string;
  userId: string;
  permission: 'READ' | 'WRITE';
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
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
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
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

interface SharedTaskList {
  id: string;
  taskListId: string;
  userId: string;
  permission: 'READ' | 'WRITE';
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  taskList: {
    id: string;
    title: string;
    updatedAt: string;
    user: {
      name: string | null;
      email: string;
    };
  };
}

interface SharedKanbanBoard {
  id: string;
  boardId: string;
  userId: string;
  permission: 'READ' | 'WRITE';
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  board: {
    id: string;
    title: string;
    description: string | null;
    ownerId: string;
    owner: {
      id: string;
      name: string | null;
      email: string;
    };
  };
}

export default function SharedWithMePage() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<'notes' | 'notebooks' | 'taskLists' | 'kanbanBoards'>('notes');
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([]);
  const [sharedNotebooks, setSharedNotebooks] = useState<SharedNotebook[]>([]);
  const [sharedTaskLists, setSharedTaskLists] = useState<SharedTaskList[]>([]);
  const [sharedKanbanBoards, setSharedKanbanBoards] = useState<SharedKanbanBoard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  const fetchData = async () => {
    setIsLoading(true);
    try {
      const [notes, notebooks, taskLists, kanbanBoards] = await Promise.all([
        getSharedNotes(),
        getSharedNotebooks(),
        api.get<SharedTaskList[]>('/share/tasklists').then(r => r.data).catch(() => []),
        api.get<SharedKanbanBoard[]>('/share/kanbans').then(r => r.data).catch(() => [])
      ]);
      setSharedNotes(notes);
      setSharedNotebooks(notebooks);
      setSharedTaskLists(taskLists);
      setSharedKanbanBoards(kanbanBoards);
    } catch (error) {
      console.error('Failed to fetch shared items', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleRespond = async (itemId: string, type: 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN', action: 'accept' | 'decline') => {
    try {
      // We need a service function in frontend api to call /share/respond-id
      // For now using raw fetch or api client if available here
      // Assumption: api client logic is simpler
      // Use auth store to get token
      const token = useAuthStore.getState().token;

      const response = await fetch(`${import.meta.env.VITE_API_URL}/share/respond-id`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ itemId, type, action })
      });

      if (response.ok) {
        fetchData(); // Reload list
      } else {
        console.error('Failed to respond');
      }
    } catch (e) {
      console.error('Error responding', e);
    }
  };

  const filterItems = (items: any[]) => {
    const pending = items.filter(i => i.status === 'PENDING');
    const accepted = items.filter(i => i.status === 'ACCEPTED');
    return { pending, accepted };
  };

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
        <button
          onClick={() => setActiveTab('taskLists')}
          className={clsx(
            "px-6 py-3 text-sm font-medium border-b-2 transition-colors",
            activeTab === 'taskLists'
              ? "border-emerald-600 text-emerald-600 dark:text-emerald-500"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          )}
        >
          {t('sidebar.taskLists')} ({sharedTaskLists.length})
        </button>
        <button
          onClick={() => setActiveTab('kanbanBoards')}
          className={clsx(
            "px-6 py-3 text-sm font-medium border-b-2 transition-colors",
            activeTab === 'kanbanBoards'
              ? "border-emerald-600 text-emerald-600 dark:text-emerald-500"
              : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          )}
        >
          {t('sidebar.kanban')} ({sharedKanbanBoards.length})
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-gray-400">
            {t('common.loading')}
          </div>
        ) : (
          <div className="space-y-8">
            {/* PENDING SECTION */}
            {(() => {
              const { pending, accepted } = filterItems(
                activeTab === 'notes' ? sharedNotes
                : activeTab === 'notebooks' ? sharedNotebooks
                : activeTab === 'taskLists' ? sharedTaskLists
                : sharedKanbanBoards
              );
              if (pending.length === 0 && accepted.length === 0) {
                return (
                  <div className="text-center text-gray-500 py-12">
                    {activeTab === 'notes' ? t('sharing.noSharedNotes')
                      : activeTab === 'notebooks' ? t('sharing.noSharedNotebooks')
                      : activeTab === 'taskLists' ? t('sharing.noSharedTaskLists')
                      : t('sharing.noSharedKanbanBoards')}
                  </div>
                );
              }

              // Helper to get display data from any shared item type
              function getItemData(item: any): { title: string; sharerName: string; id: string } {
                if (activeTab === 'kanbanBoards') {
                  const kb = item as SharedKanbanBoard;
                  return {
                    title: kb.board.title || t('notes.untitled'),
                    sharerName: kb.board.owner.name || kb.board.owner.email,
                    id: kb.board.id,
                  };
                }
                const data = activeTab === 'notes' ? (item as SharedNote).note
                  : activeTab === 'notebooks' ? (item as SharedNotebook).notebook
                  : (item as SharedTaskList).taskList;
                return {
                  title: (data as any).title || (data as any).name || t('notes.untitled'),
                  sharerName: data.user.name || data.user.email,
                  id: data.id,
                };
              }

              function getRespondType(): 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN' {
                if (activeTab === 'notes') return 'NOTE';
                if (activeTab === 'notebooks') return 'NOTEBOOK';
                if (activeTab === 'taskLists') return 'TASKLIST';
                return 'KANBAN';
              }

              function getTabIcon() {
                if (activeTab === 'notes') return <FileText className="text-gray-400 dark:text-gray-500" size={20} />;
                if (activeTab === 'notebooks') return <Book className="text-gray-400 dark:text-gray-500" size={20} />;
                if (activeTab === 'taskLists') return <ListChecks className="text-gray-400 dark:text-gray-500" size={20} />;
                return <Columns3 className="text-gray-400 dark:text-gray-500" size={20} />;
              }

              function getAcceptedLink(id: string) {
                if (activeTab === 'notes') return `/notes?noteId=${id}`;
                if (activeTab === 'notebooks') return `/notes?notebookId=${id}`;
                if (activeTab === 'taskLists') return `/tasks`;
                return `/kanban?boardId=${id}`;
              }

              return (
                <>
                  {pending.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4 px-1">{t('sharing.pendingInvitations')}</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {pending.map(item => {
                          const { title, sharerName, id } = getItemData(item);
                          const respondType = getRespondType();
                          return (
                            <div key={item.id} className="block p-4 rounded-xl border border-yellow-200 bg-yellow-50 dark:bg-yellow-900/10 dark:border-yellow-900/30">
                              <div className="flex items-start justify-between mb-2">
                                <span className="text-xs font-bold text-yellow-700 dark:text-yellow-500">{t('sharing.invitation')}</span>
                                <span className="text-xs px-2 py-0.5 rounded-full bg-white text-gray-600 dark:bg-gray-800 dark:text-gray-300 border border-gray-100 dark:border-gray-700">{item.permission}</span>
                              </div>
                              <h3 className="font-semibold text-gray-900 mb-1 truncate dark:text-white">{title}</h3>
                              <div className="text-xs text-gray-500 mt-2 mb-4">
                                {t('sharing.sharedBy')} <span className="font-medium text-gray-700 dark:text-gray-300">{sharerName}</span>
                              </div>
                              <div className="flex gap-2">
                                <button
                                  onClick={() => handleRespond(id, respondType, 'accept')}
                                  className="flex-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
                                >
                                  {t('common.accept')}
                                </button>
                                <button
                                  onClick={() => handleRespond(id, respondType, 'decline')}
                                  className="flex-1 px-3 py-1.5 bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 text-sm font-medium rounded-lg transition-colors dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                                >
                                  {t('common.decline')}
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* ACCEPTED SECTION */}
                  {accepted.length > 0 && (
                    <div>
                      {pending.length > 0 && <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-4 px-1 mt-8">{t('sharing.sharedWithYou')}</h3>}
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {accepted.map(item => {
                          const { title, sharerName, id } = getItemData(item);
                          const link = getAcceptedLink(id);
                          return (
                            <Link
                              key={item.id}
                              to={link}
                              className="block p-4 rounded-xl border border-gray-200 hover:border-emerald-500 hover:shadow-md transition-all bg-white dark:bg-gray-800 dark:border-gray-700 dark:hover:border-emerald-500"
                            >
                              <div className="flex items-start justify-between mb-2">
                                {getTabIcon()}
                                <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                                  {item.permission}
                                </span>
                              </div>
                              <h3 className="font-semibold text-gray-900 mb-1 truncate dark:text-white">{title}</h3>
                              <div className="text-xs text-gray-500 dark:text-gray-400 mt-2 flex items-center gap-1">
                                <span>{t('sharing.sharedBy')}</span>
                                <span className="font-medium text-gray-700 dark:text-gray-300">{sharerName}</span>
                              </div>
                            </Link>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
