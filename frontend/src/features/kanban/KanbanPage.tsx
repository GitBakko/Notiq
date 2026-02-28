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
import Skeleton from '../../components/ui/Skeleton';

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
  const viewSharesUsers: SharedUserInfo[] = viewSharesBoard?.shares
    ?.filter(s => s.status === 'ACCEPTED' || s.status === 'PENDING')
    .map(s => ({
      id: s.user.id,
      name: s.user.name,
      email: s.user.email,
      avatarUrl: s.user.avatarUrl,
      permission: s.permission,
      status: s.status as 'ACCEPTED' | 'PENDING',
    })) || [];
  const viewSharesOwner: SharedOwnerInfo | null = viewSharesBoard
    ? (viewSharesBoard.owner
        ? { id: viewSharesBoard.owner.id, name: viewSharesBoard.owner.name, email: viewSharesBoard.owner.email, avatarUrl: viewSharesBoard.owner.avatarUrl }
        : user ? { id: user.id, name: user.name || null, email: user.email, avatarUrl: user.avatarUrl } : null)
    : null;

  function handleSelectBoard(id: string): void {
    navigate(`/kanban?boardId=${id}`);
  }

  function handleDeleteBoard(id: string): void {
    deleteBoard.mutate(id);
  }

  return (
    <div className="flex-1 h-full overflow-y-auto bg-neutral-50 dark:bg-neutral-950">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-white/80 dark:bg-neutral-950/80 backdrop-blur-md border-b border-neutral-200/60 dark:border-neutral-800/40 shadow-[0_1px_3px_0_rgb(0,0,0,0.02)] px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {isMobile && (
              <button
                onClick={toggleSidebar}
                className="text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200"
              >
                <Menu size={24} />
              </button>
            )}
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-white flex items-center gap-2">
              <Kanban className="text-emerald-600" size={24} />
              {t('kanban.title')}
            </h1>
          </div>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="flex items-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{t('kanban.newBoard')}</span>
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-5xl mx-auto px-6 py-6">
        {isLoading ? (
          <Skeleton.Grid count={3} />
        ) : !boards || boards.length === 0 ? (
          <div className="text-center py-20">
            <Kanban className="mx-auto text-neutral-300 dark:text-neutral-600 mb-4" size={48} />
            <h3 className="text-lg font-medium text-neutral-600 dark:text-neutral-400 mb-1">
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
