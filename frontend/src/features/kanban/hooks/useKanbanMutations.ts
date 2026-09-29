import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../../../lib/queryKeys';
import { LOCAL_FIRST } from '../../../lib/networkMode';
import * as kanbanService from '../kanbanService';
import { syncPush } from '../../sync/syncService';
import type { KanbanCardPriority } from '../types';

export function useKanbanMutations(boardId?: string) {
  const queryClient = useQueryClient();

  function invalidateBoard(): void {
    if (boardId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.kanban.board(boardId) });
    }
  }

  // [BACKUP] 2026-09-29 — kanban 3.4: was `syncPush().catch(() => {})` followed by an
  // immediate invalidateBoard() in every onSuccess. That refetched the board from the
  // server before the write got there, so a quick second move jumped back for a while.
  // Push, then refetch: syncPush now resolves only once what was queued is on the
  // server (or the push gave up, e.g. offline — the refetch then falls back to Dexie).
  function flushSync(): void {
    void syncPush().catch(() => false).then(invalidateBoard);
  }

  const createBoard = useMutation({
    mutationFn: kanbanService.createBoard,
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const deleteBoard = useMutation({
    mutationFn: kanbanService.deleteBoard,
    onSuccess: (_data, deletedId) => {
      flushSync();
      queryClient.removeQueries({ queryKey: queryKeys.kanban.board(deletedId) });
      queryClient.removeQueries({ queryKey: queryKeys.kanban.boardChat(deletedId) });
    },
    ...LOCAL_FIRST,
  });

  const updateBoard = useMutation({
    mutationFn: ({ id, ...data }: { id: string; title?: string; description?: string | null }) =>
      kanbanService.updateBoard(id, data),
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const createColumn = useMutation({
    mutationFn: ({ boardId: bid, title }: { boardId: string; title: string }) =>
      kanbanService.createColumn(bid, title),
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const updateColumn = useMutation({
    mutationFn: ({ columnId, ...data }: { columnId: string; title?: string; isCompleted?: boolean }) =>
      kanbanService.updateColumn(columnId, data),
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const deleteColumn = useMutation({
    mutationFn: kanbanService.deleteColumn,
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const reorderColumns = useMutation({
    mutationFn: ({ boardId: bid, columns }: { boardId: string; columns: { id: string; position: number }[] }) =>
      kanbanService.reorderColumns(bid, columns),
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const createCard = useMutation({
    mutationFn: ({ columnId, ...data }: { columnId: string; title: string; description?: string }) =>
      kanbanService.createCard(columnId, data),
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
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
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const moveCard = useMutation({
    mutationFn: ({ cardId, toColumnId, position }: { cardId: string; toColumnId: string; position: number }) =>
      kanbanService.moveCard(cardId, toColumnId, position),
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const deleteCard = useMutation({
    mutationFn: kanbanService.deleteCard,
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  const duplicateCard = useMutation({
    mutationFn: kanbanService.duplicateCard,
    onSuccess: () => flushSync(),
    ...LOCAL_FIRST,
  });

  // Server-only mutations (no Dexie, no syncPush)
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

  const unarchiveCard = useMutation({
    mutationFn: kanbanService.unarchiveCard,
    onSuccess: invalidateBoard,
  });

  const linkTaskList = useMutation({
    mutationFn: ({ boardId: bid, taskListId }: { boardId: string; taskListId: string }) =>
      kanbanService.linkTaskList(bid, taskListId),
    onSuccess: invalidateBoard,
  });

  const unlinkTaskList = useMutation({
    mutationFn: kanbanService.unlinkTaskList,
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
    duplicateCard,
    uploadCover,
    deleteCover,
    linkNote,
    unlinkNote,
    linkBoardNote,
    unlinkBoardNote,
    uploadAvatar,
    deleteAvatar,
    unarchiveCard,
    linkTaskList,
    unlinkTaskList,
  };
}
