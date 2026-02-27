import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Kanban, Plus, Menu } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useKanbanBoards } from './hooks/useKanbanBoards';
import { useKanbanMutations } from './hooks/useKanbanMutations';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUIStore } from '../../store/uiStore';
import BoardCard from './components/BoardCard';
import CreateBoardModal from './components/CreateBoardModal';
import ShareBoardModal from './components/ShareBoardModal';
import SharedUsersModal from '../../components/sharing/SharedUsersModal';
import type { SharedUserInfo, SharedOwnerInfo } from '../../components/sharing/SharedUsersModal';
import KanbanBoardPage from './KanbanBoardPage';
import type { KanbanBoardListItem } from './types';
import { useAuthStore } from '../../store/authStore';

export default function KanbanPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const boardId = searchParams.get('boardId') || undefined;

  const { data: boards, isLoading } = useKanbanBoards();
  const { deleteBoard } = useKanbanMutations();
  const isMobile = useIsMobile();
  const { toggleSidebar } = useUIStore();
  const user = useAuthStore((s) => s.user);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [sharingBoardId, setSharingBoardId] = useState<string | null>(null);
  const [viewSharesBoardId, setViewSharesBoardId] = useState<string | null>(null);

  // If a boardId is selected, render the board view
  if (boardId) {
    return <KanbanBoardPage boardId={boardId} />;
  }

  const sharingBoard = sharingBoardId
    ? boards?.find((b) => b.id === sharingBoardId)
    : null;

  const viewSharesBoard = viewSharesBoardId
    ? boards?.find((b) => b.id === viewSharesBoardId)
    : null;
  const viewSharesUsers: SharedUserInfo[] = viewSharesBoard?.shares?.map(s => ({
    id: s.user.id,
    name: s.user.name,
    email: s.user.email,
    avatarUrl: s.user.avatarUrl,
    permission: s.permission,
  })) || [];
  const viewSharesOwner: SharedOwnerInfo | null = viewSharesBoard
    ? (viewSharesBoard.owner
        ? { id: viewSharesBoard.owner.id, name: viewSharesBoard.owner.name, email: viewSharesBoard.owner.email }
        : user ? { id: user.id, name: user.name || null, email: user.email } : null)
    : null;

  function handleSelectBoard(id: string): void {
    navigate(`/kanban?boardId=${id}`);
  }

  function handleDeleteBoard(id: string): void {
    deleteBoard.mutate(id);
  }

  return (
    <div className="flex-1 h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-gray-50/80 dark:bg-gray-900/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
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
              <Kanban className="text-emerald-600" size={24} />
              {t('kanban.title')}
            </h1>
          </div>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={16} />
            {t('kanban.newBoard')}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600" />
          </div>
        ) : !boards || boards.length === 0 ? (
          <div className="text-center py-20">
            <Kanban className="mx-auto text-gray-300 dark:text-gray-600 mb-4" size={48} />
            <h3 className="text-lg font-medium text-gray-600 dark:text-gray-400 mb-1">
              {t('kanban.noBoards')}
            </h3>
            <button
              onClick={() => setIsCreateOpen(true)}
              className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
            >
              <Plus size={16} />
              {t('kanban.newBoard')}
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {boards.map((board: KanbanBoardListItem) => (
              <BoardCard
                key={board.id}
                board={board}
                onSelect={handleSelectBoard}
                onShare={(id) => setSharingBoardId(id)}
                onDelete={handleDeleteBoard}
                onViewShares={(id) => setViewSharesBoardId(id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      <CreateBoardModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
      />
      {sharingBoardId && sharingBoard && (
        <ShareBoardModal
          isOpen={!!sharingBoardId}
          onClose={() => setSharingBoardId(null)}
          boardId={sharingBoardId}
          boardTitle={sharingBoard.title}
        />
      )}
      <SharedUsersModal
        isOpen={!!viewSharesBoardId}
        onClose={() => setViewSharesBoardId(null)}
        users={viewSharesUsers}
        currentUserId={user?.id}
        owner={viewSharesOwner}
      />
    </div>
  );
}
