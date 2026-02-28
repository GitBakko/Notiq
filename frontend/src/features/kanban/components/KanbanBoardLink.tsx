import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { LayoutDashboard, SquareKanban } from 'lucide-react';
import { getLinkedBoardsForNote } from '../kanbanService';

interface KanbanBoardLinkProps {
  noteId: string;
}

/**
 * Shows quick-link buttons to Kanban boards that have cards or the board itself linked to this note.
 * Navigating passes highlightCards query param for card links to trigger pulse effect.
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
    <div className="flex items-center gap-2 flex-wrap px-4 py-1.5 border-b border-neutral-100 dark:border-neutral-800">
      {linkedBoards.map((entry) => {
        const isBoard = entry.linkedAs === 'board';
        const Icon = isBoard ? LayoutDashboard : SquareKanban;
        const label = isBoard
          ? t('kanban.noteLink.boardLabel', { boardTitle: entry.boardTitle })
          : entry.cardTitles.length === 1
            ? t('kanban.noteLink.cardLabel', { cardTitle: entry.cardTitles[0], boardTitle: entry.boardTitle })
            : `${entry.cardTitles.length} cards (${entry.boardTitle})`;

        const url = isBoard
          ? `/kanban?boardId=${entry.boardId}`
          : `/kanban?boardId=${entry.boardId}&highlightCards=${entry.cardIds.join(',')}`;

        return (
          <button
            key={`${entry.boardId}-${entry.linkedAs}`}
            onClick={() => navigate(url)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 rounded hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
            title={t('kanban.noteLink.goToBoard', { boardTitle: entry.boardTitle })}
          >
            {entry.boardAvatarUrl ? (
              <img src={entry.boardAvatarUrl} alt="" className="w-4 h-4 rounded-full object-cover" />
            ) : (
              <Icon size={12} />
            )}
            {label}
          </button>
        );
      })}
    </div>
  );
}
