import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as kanbanService from '../kanbanService';
import type { KanbanBoardListItem, KanbanCardPriority } from '../types';

export function useKanbanMutations(boardId?: string) {
  const queryClient = useQueryClient();

  function invalidateBoard(): void {
    if (boardId) {
      queryClient.invalidateQueries({ queryKey: ['kanban-board', boardId] });
    }
    queryClient.invalidateQueries({ queryKey: ['kanban-boards'] });
  }

  const createBoard = useMutation({
    mutationFn: kanbanService.createBoard,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['kanban-boards'] }),
  });

  const deleteBoard = useMutation({
    mutationFn: kanbanService.deleteBoard,
    onMutate: async (deletedId) => {
      await queryClient.cancelQueries({ queryKey: ['kanban-boards'] });
      const previousBoards = queryClient.getQueryData<KanbanBoardListItem[]>(['kanban-boards']);
      queryClient.setQueryData<KanbanBoardListItem[]>(['kanban-boards'], (old) =>
        old ? old.filter((b) => b.id !== deletedId) : [],
      );
      return { previousBoards };
    },
    onError: (_err, _deletedId, context) => {
      if (context?.previousBoards) {
        queryClient.setQueryData(['kanban-boards'], context.previousBoards);
      }
    },
    onSettled: (_data, _error, deletedId) => {
      // Remove stale individual board queries to prevent 404 refetches
      queryClient.removeQueries({ queryKey: ['kanban-board', deletedId] });
      queryClient.removeQueries({ queryKey: ['kanban-board-chat', deletedId] });
      queryClient.invalidateQueries({ queryKey: ['kanban-boards'] });
    },
  });

  const updateBoard = useMutation({
    mutationFn: ({ id, ...data }: { id: string; title?: string; description?: string | null }) =>
      kanbanService.updateBoard(id, data),
    onSuccess: invalidateBoard,
  });

  const createColumn = useMutation({
    mutationFn: ({ boardId: bid, title }: { boardId: string; title: string }) =>
      kanbanService.createColumn(bid, title),
    onSuccess: invalidateBoard,
  });

  const updateColumn = useMutation({
    mutationFn: ({ columnId, title }: { columnId: string; title: string }) =>
      kanbanService.updateColumn(columnId, title),
    onSuccess: invalidateBoard,
  });

  const deleteColumn = useMutation({
    mutationFn: kanbanService.deleteColumn,
    onSuccess: invalidateBoard,
  });

  const reorderColumns = useMutation({
    mutationFn: ({ boardId: bid, columns }: { boardId: string; columns: { id: string; position: number }[] }) =>
      kanbanService.reorderColumns(bid, columns),
    onSuccess: invalidateBoard,
  });

  const createCard = useMutation({
    mutationFn: ({ columnId, ...data }: { columnId: string; title: string; description?: string }) =>
      kanbanService.createCard(columnId, data),
    onSuccess: invalidateBoard,
  });

  const updateCard = useMutation({
    mutationFn: ({
      cardId,
      ...data
    }: {
      cardId: string;
      title?: string;
      description?: string | null;
      assigneeId?: string | null;
      dueDate?: string | null;
      priority?: KanbanCardPriority | null;
    }) => kanbanService.updateCard(cardId, data),
    onSuccess: invalidateBoard,
  });

  const moveCard = useMutation({
    mutationFn: ({ cardId, toColumnId, position }: { cardId: string; toColumnId: string; position: number }) =>
      kanbanService.moveCard(cardId, toColumnId, position),
    onSuccess: invalidateBoard,
  });

  const deleteCard = useMutation({
    mutationFn: kanbanService.deleteCard,
    onSuccess: invalidateBoard,
  });

  const uploadCover = useMutation({
    mutationFn: ({ bid, file }: { bid: string; file: File }) =>
      kanbanService.uploadCoverImage(bid, file),
    onSuccess: invalidateBoard,
  });

  const deleteCover = useMutation({
    mutationFn: kanbanService.deleteCoverImage,
    onSuccess: invalidateBoard,
  });

  const linkNote = useMutation({
    mutationFn: ({ cardId, noteId, shareWithUserIds }: { cardId: string; noteId: string; shareWithUserIds?: string[] }) =>
      kanbanService.linkNoteToCard(cardId, noteId, shareWithUserIds),
    onSuccess: invalidateBoard,
  });

  const unlinkNote = useMutation({
    mutationFn: kanbanService.unlinkNoteFromCard,
    onSuccess: invalidateBoard,
  });

  const linkBoardNote = useMutation({
    mutationFn: ({ boardId: bid, noteId, shareWithUserIds }: { boardId: string; noteId: string; shareWithUserIds?: string[] }) =>
      kanbanService.linkNoteToBoard(bid, noteId, shareWithUserIds),
    onSuccess: invalidateBoard,
  });

  const unlinkBoardNote = useMutation({
    mutationFn: kanbanService.unlinkNoteFromBoard,
    onSuccess: invalidateBoard,
  });

  const uploadAvatar = useMutation({
    mutationFn: ({ bid, file }: { bid: string; file: File }) =>
      kanbanService.uploadAvatar(bid, file),
    onSuccess: invalidateBoard,
  });

  const deleteAvatar = useMutation({
    mutationFn: kanbanService.deleteAvatar,
    onSuccess: invalidateBoard,
  });

  return {
    createBoard,
    deleteBoard,
    updateBoard,
    createColumn,
    updateColumn,
    deleteColumn,
    reorderColumns,
    createCard,
    updateCard,
    moveCard,
    deleteCard,
    uploadCover,
    deleteCover,
    linkNote,
    unlinkNote,
    linkBoardNote,
    unlinkBoardNote,
    uploadAvatar,
    deleteAvatar,
  };
}
