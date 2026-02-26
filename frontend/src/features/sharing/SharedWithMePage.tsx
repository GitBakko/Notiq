import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Users, FileText, Book, Menu, ListChecks, Columns3, Send, RefreshCw, X } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { getSharedNotes } from '../notes/noteService';
import { getSharedNotebooks } from '../notebooks/notebookService';
import clsx from 'clsx';
import { useIsMobile } from '../../hooks/useIsMobile';
import api from '../../lib/api';
import { useUIStore } from '../../store/uiStore';

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

interface SentShareItem {
  id: string;
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
  permission: 'READ' | 'WRITE';
  createdAt: string;
  user: { id: string; name: string | null; email: string };
  note?: { id: string; title: string };
  notebook?: { id: string; name: string };
  taskList?: { id: string; title: string };
  board?: { id: string; title: string; description: string | null };
}

interface SentData {
  notes: SentShareItem[];
  notebooks: SentShareItem[];
  taskLists: SentShareItem[];
  kanbanBoards: SentShareItem[];
}

export default function SharedWithMePage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab') as 'notes' | 'notebooks' | 'taskLists' | 'kanbanBoards' | null;
  const highlightParam = searchParams.get('highlight');
  const [activeTab, setActiveTab] = useState<'notes' | 'notebooks' | 'taskLists' | 'kanbanBoards'>(tabParam || 'notes');
  const [highlightedId, setHighlightedId] = useState<string | null>(highlightParam);
  const highlightRef = useRef<HTMLDivElement | HTMLAnchorElement>(null);
  const [sharedNotes, setSharedNotes] = useState<SharedNote[]>([]);
  const [sharedNotebooks, setSharedNotebooks] = useState<SharedNotebook[]>([]);
  const [sharedTaskLists, setSharedTaskLists] = useState<SharedTaskList[]>([]);
  const [sharedKanbanBoards, setSharedKanbanBoards] = useState<SharedKanbanBoard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [view, setView] = useState<'received' | 'sent'>('received');
  const [sentData, setSentData] = useState<SentData | null>(null);
  const [isSentLoading, setIsSentLoading] = useState(false);
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();

  // Handle tab/highlight from URL params
  useEffect(() => {
    if (tabParam && tabParam !== activeTab) {
      setActiveTab(tabParam);
    }
    if (highlightParam) {
      setHighlightedId(highlightParam);
      // Clear URL params after reading
      setSearchParams({}, { replace: true });
      // Auto-clear highlight after 3 seconds
      const timer = setTimeout(() => setHighlightedId(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [tabParam, highlightParam]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightedId && highlightRef.current && !isLoading) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedId, isLoading]);

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

  const fetchSentData = async () => {
    setIsSentLoading(true);
    try {
      const res = await api.get('/share/sent');
      setSentData(res.data);
    } catch (error) {
      console.error('Failed to fetch sent invitations', error);
    } finally {
      setIsSentLoading(false);
    }
  };

  useEffect(() => {
    if (view === 'sent' && !sentData) {
      fetchSentData();
    }
  }, [view]);

  const handleResend = async (type: string, shareId: string) => {
    try {
      await api.post(`/share/resend/${type}/${shareId}`);
      toast.success(t('sharing.resendSuccess'));
    } catch {
      toast.error(t('sharing.resendFailed'));
    }
  };

  const handleCancelOrRevoke = async (type: string, entityId: string, userId: string, status?: string) => {
    try {
      const typeMap: Record<string, string> = {
        NOTE: 'notes', NOTEBOOK: 'notebooks', TASKLIST: 'tasklists', KANBAN: 'kanbans',
      };
      await api.delete(`/share/${typeMap[type]}/${entityId}/${userId}`);
      toast.success(t(status === 'ACCEPTED' ? 'sharing.revokeSuccess' : 'sharing.cancelSuccess'));
      fetchSentData();
    } catch {
      toast.error(t('sharing.cancelFailed'));
    }
  };

  const handleRespond = async (itemId: string, type: 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN', action: 'accept' | 'decline') => {
    try {
      await api.post('/share/respond-id', { itemId, type, action });
      fetchData();
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
            {view === 'received'
              ? <Users className="text-emerald-600" />
              : <Send className="text-emerald-600" />}
            {t('sharing.title')}
          </h1>
        </div>
        <p className="text-gray-500 mt-1 dark:text-gray-400">
          {view === 'received' ? t('sharing.sharedWithMeSubtitle') : t('sharing.sentSubtitle')}
        </p>
        <div className="flex gap-2 mt-3">
          <button
            onClick={() => setView('received')}
            className={clsx(
              "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
              view === 'received'
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            )}
          >
            {t('sharing.received')}
          </button>
          <button
            onClick={() => setView('sent')}
            className={clsx(
              "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
              view === 'sent'
                ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            )}
          >
            {t('sharing.sent')}
          </button>
        </div>
      </div>

      {view === 'received' && (
        <>
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
                                <div
                                  key={item.id}
                                  ref={highlightedId === id ? highlightRef as React.RefObject<HTMLDivElement> : undefined}
                                  className={clsx(
                                    "block p-4 rounded-xl border transition-all",
                                    highlightedId === id
                                      ? "ring-2 ring-emerald-400 shadow-md shadow-emerald-100 dark:shadow-emerald-900/30 animate-pulse border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 dark:border-emerald-500"
                                      : "border-yellow-200 bg-yellow-50 dark:bg-yellow-900/10 dark:border-yellow-900/30"
                                  )}
                                >
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
                                  ref={highlightedId === id ? highlightRef as React.Ref<HTMLAnchorElement> : undefined}
                                  className={clsx(
                                    "block p-4 rounded-xl border transition-all",
                                    highlightedId === id
                                      ? "ring-2 ring-emerald-400 shadow-md shadow-emerald-100 dark:shadow-emerald-900/30 animate-pulse border-emerald-400 dark:border-emerald-500 bg-emerald-50 dark:bg-emerald-900/20"
                                      : "border-gray-200 hover:border-emerald-500 hover:shadow-md bg-white dark:bg-gray-800 dark:border-gray-700 dark:hover:border-emerald-500"
                                  )}
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
        </>
      )}

      {view === 'sent' && (
        <>
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
              {t('sidebar.notes')}
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
              {t('sidebar.notebooks')}
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
              {t('sidebar.taskLists')}
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
              {t('sidebar.kanban')}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {isSentLoading ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                {t('common.loading')}
              </div>
            ) : (
              <SentItemsGrid
                sentData={sentData}
                activeTab={activeTab}
                onResend={handleResend}
                onCancelOrRevoke={handleCancelOrRevoke}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}

const statusColors: Record<string, string> = {
  PENDING: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  ACCEPTED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400',
  DECLINED: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

function getSentEntityId(item: SentShareItem, activeTab: string): string {
  if (activeTab === 'notes') return item.note!.id;
  if (activeTab === 'notebooks') return item.notebook!.id;
  if (activeTab === 'taskLists') return item.taskList!.id;
  return item.board!.id;
}

function getSentEntityName(item: SentShareItem, activeTab: string): string {
  if (activeTab === 'notes') return item.note!.title;
  if (activeTab === 'notebooks') return item.notebook!.name;
  if (activeTab === 'taskLists') return item.taskList!.title;
  return item.board!.title;
}

function getSentType(activeTab: string): string {
  if (activeTab === 'notes') return 'NOTE';
  if (activeTab === 'notebooks') return 'NOTEBOOK';
  if (activeTab === 'taskLists') return 'TASKLIST';
  return 'KANBAN';
}

function getSentItems(sentData: SentData | null, activeTab: string): SentShareItem[] | undefined {
  if (activeTab === 'notes') return sentData?.notes;
  if (activeTab === 'notebooks') return sentData?.notebooks;
  if (activeTab === 'taskLists') return sentData?.taskLists;
  return sentData?.kanbanBoards;
}

interface SentItemsGridProps {
  sentData: SentData | null;
  activeTab: string;
  onResend: (type: string, shareId: string) => void;
  onCancelOrRevoke: (type: string, entityId: string, userId: string, status?: string) => void;
}

function SentItemsGrid({ sentData, activeTab, onResend, onCancelOrRevoke }: SentItemsGridProps) {
  const { t } = useTranslation();
  const sentItems = getSentItems(sentData, activeTab);
  const type = getSentType(activeTab);

  if (!sentItems || sentItems.length === 0) {
    return (
      <div className="text-center text-gray-500 dark:text-gray-400 py-12">
        {t('sharing.noSentInvitations')}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {sentItems.map((item: any) => {
        const entityName = getSentEntityName(item, activeTab);
        const entityId = getSentEntityId(item, activeTab);
        const statusKey = `sharing.status${item.status.charAt(0) + item.status.slice(1).toLowerCase()}`;

        return (
          <div
            key={item.id}
            className="block p-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
          >
            <div className="flex items-start justify-between mb-2">
              <span className={clsx("text-xs font-bold px-2 py-0.5 rounded-full", statusColors[item.status])}>
                {t(statusKey)}
              </span>
              <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                {item.permission}
              </span>
            </div>
            <h3 className="font-semibold text-gray-900 dark:text-white mb-1 truncate">{entityName}</h3>
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">
              {t('sharing.sentTo')} <span className="font-medium text-gray-700 dark:text-gray-300">{item.user.name || item.user.email}</span>
            </div>
            <div className="text-xs text-gray-400 dark:text-gray-500 mb-3">
              {new Date(item.createdAt).toLocaleDateString()}
            </div>
            <div className="flex gap-2">
              {item.status === 'PENDING' && (
                <>
                  <button
                    onClick={() => onResend(type, item.id)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors"
                  >
                    <RefreshCw size={12} />
                    {t('sharing.resend')}
                  </button>
                  <button
                    onClick={() => onCancelOrRevoke(type, entityId, item.user.id, item.status)}
                    className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-white hover:bg-gray-50 text-gray-700 border border-gray-300 rounded-lg transition-colors dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
                  >
                    <X size={12} />
                    {t('sharing.cancelInvite')}
                  </button>
                </>
              )}
              {item.status === 'ACCEPTED' && (
                <button
                  onClick={() => onCancelOrRevoke(type, entityId, item.user.id, item.status)}
                  className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 border border-red-200 rounded-lg transition-colors dark:text-red-400 dark:border-red-900/50 dark:hover:bg-red-900/20"
                >
                  {t('sharing.revokeAccess')}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
