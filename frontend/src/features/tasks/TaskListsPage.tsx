import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListChecks, Plus, Menu } from 'lucide-react';
import { useTaskLists } from '../../hooks/useTaskLists';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import TaskListCard from './TaskListCard';
import NewTaskListModal from './NewTaskListModal';
import TaskListSharingModal from './TaskListSharingModal';
import SharedUsersModal from '../../components/sharing/SharedUsersModal';
import type { SharedUserInfo, SharedOwnerInfo } from '../../components/sharing/SharedUsersModal';
import type { LocalTaskList, LocalTaskItem } from '../../lib/db';
import { useAuthStore } from '../../store/authStore';

export default function TaskListsPage() {
  const { t } = useTranslation();
  const taskLists = useTaskLists();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();
  const user = useAuthStore((s) => s.user);
  const [isNewModalOpen, setIsNewModalOpen] = useState(false);
  const [sharingTaskListId, setSharingTaskListId] = useState<string | null>(null);
  const [viewSharesTaskListId, setViewSharesTaskListId] = useState<string | null>(null);

  // Find the task list being shared for the modal
  const sharingTaskList = sharingTaskListId
    ? taskLists?.find(tl => tl.id === sharingTaskListId)
    : null;

  // Find the task list for viewing shares (read-only modal)
  const viewSharesTaskList = viewSharesTaskListId
    ? taskLists?.find(tl => tl.id === viewSharesTaskListId)
    : null;
  const viewSharesUsers: SharedUserInfo[] = viewSharesTaskList?.sharedWith
    ?.filter(s => s.status === 'ACCEPTED')
    .map(s => ({ id: s.userId, name: s.user.name, email: s.user.email, permission: s.permission })) || [];
  const viewSharesOwner: SharedOwnerInfo | null = viewSharesTaskList
    ? (viewSharesTaskList.sharedByUser
        ? { id: viewSharesTaskList.sharedByUser.id, name: viewSharesTaskList.sharedByUser.name, email: viewSharesTaskList.sharedByUser.email }
        : user ? { id: user.id, name: user.name || null, email: user.email } : null)
    : null;

  return (
    <div className="flex-1 h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-gray-50/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800 px-6 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isMobile && (
              <button
                onClick={toggleSidebar}
                className="text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <Menu size={24} />
              </button>
            )}
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              <ListChecks className="text-emerald-600" size={24} />
              {t('taskLists.title')}
            </h1>
          </div>
          <button
            onClick={() => setIsNewModalOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={16} />
            {t('taskLists.newList')}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
        {!taskLists ? (
          // Loading state
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
          </div>
        ) : taskLists.length === 0 ? (
          // Empty state
          <div className="text-center py-20">
            <ListChecks className="mx-auto text-gray-300 dark:text-gray-600 mb-4" size={48} />
            <h3 className="text-lg font-medium text-gray-600 dark:text-gray-400 mb-1">
              {t('taskLists.noLists')}
            </h3>
            <p className="text-sm text-gray-400 dark:text-gray-500 mb-6">
              {t('taskLists.noListsDescription')}
            </p>
            <button
              onClick={() => setIsNewModalOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus size={16} />
              {t('taskLists.newList')}
            </button>
          </div>
        ) : (
          // Task list cards
          taskLists.map((tl) => (
            <TaskListCard
              key={tl.id}
              taskList={tl as LocalTaskList & { items: LocalTaskItem[] }}
              readOnly={tl.ownership === 'shared' && tl.sharedPermission === 'READ'}
              onShareClick={(id) => setSharingTaskListId(id)}
              onViewShares={(id) => setViewSharesTaskListId(id)}
            />
          ))
        )}
      </div>

      {/* Modals */}
      <NewTaskListModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
      />
      {sharingTaskListId && sharingTaskList && (
        <TaskListSharingModal
          isOpen={!!sharingTaskListId}
          onClose={() => setSharingTaskListId(null)}
          taskListId={sharingTaskListId}
          sharedWith={
            sharingTaskList.sharedWith
              ?.filter(s => s.status === 'ACCEPTED')
              .map(s => ({
                id: s.userId,
                name: s.user.name,
                email: s.user.email,
                permission: s.permission,
              })) || []
          }
        />
      )}
      <SharedUsersModal
        isOpen={!!viewSharesTaskListId}
        onClose={() => setViewSharesTaskListId(null)}
        users={viewSharesUsers}
        currentUserId={user?.id}
        owner={viewSharesOwner}
      />
    </div>
  );
}
