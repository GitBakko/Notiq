import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard } from 'lucide-react';
import { getLinkedBoardsForNote } from '../kanbanService';

interface KanbanBoardLinkProps {
  noteId: string;
}

/**
 * Shows quick-link buttons to Kanban boards that have cards linked to this note.
 * Navigating passes highlightCards query param to trigger pulse effect.
 */
export default function KanbanBoardLink({ noteId }: KanbanBoardLinkProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const { data: linkedBoards } = useQuery({
    queryKey: ['kanban-linked-boards', noteId],
    queryFn: () => getLinkedBoardsForNote(noteId),
    enabled: !!noteId,
    staleTime: 30_000,
  });

  if (!linkedBoards || linkedBoards.length === 0) return null;

  return (
    <div className="flex items-center gap-2 flex-wrap px-4 py-1.5 border-b border-gray-100 dark:border-gray-800">
      {linkedBoards.map((board) => (
        <button
          key={board.boardId}
          onClick={() => navigate(`/kanban?boardId=${board.boardId}&highlightCards=${board.cardIds.join(',')}`)}
          className="flex items-center gap-1 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
          title={t('kanban.noteLink.goToBoard', { boardTitle: board.boardTitle })}
        >
          <LayoutDashboard size={12} />
          {board.boardTitle}
        </button>
      ))}
    </div>
  );
}
