import { db } from '../../lib/db';
import { v4 as uuidv4 } from 'uuid';
import type { LocalKanbanBoard, LocalKanbanColumn, LocalKanbanCard } from '../../lib/db';
import { useAuthStore } from '../../store/authStore';
import api from '../../lib/api';
import type {
  KanbanBoard,
  KanbanBoardListItem,
  KanbanBoardChatMessage,
  KanbanCard,
  KanbanCardActivity,
  KanbanCardPriority,
  KanbanComment,
  NoteSharingCheck,
  NoteSearchResult,
  SharedKanbanBoard,
  ArchivedCard,
  TaskListSearchResult,
} from './types';

const getUserId = () => {
  const userId = useAuthStore.getState().user?.id;
  if (!userId) throw new Error('Not authenticated');
  return userId;
};

// ── Boards (offline-first) ──────────────────────────────────────────────

export async function listBoards(): Promise<KanbanBoardListItem[]> {
  const res = await api.get<KanbanBoardListItem[]>('/kanban/boards');
  return res.data;
}

export async function createBoard(data: {
  title: string;
  description?: string;
  columnTitles?: { todo: string; inProgress: string; done: string };
}): Promise<LocalKanbanBoard> {
  const userId = getUserId();
  const id = uuidv4();
  const now = new Date().toISOString();

  const board: LocalKanbanBoard = {
    id,
    title: data.title,
    description: data.description || null,
    coverImage: null,
    avatarUrl: null,
    ownerId: userId,
    columnCount: 3,
    cardCount: 0,
    ownership: 'owned',
    createdAt: now,
    updatedAt: now,
    syncStatus: 'created',
  };

  // Create default columns locally
  const colTitles = data.columnTitles || { todo: 'To Do', inProgress: 'In Progress', done: 'Done' };
  const columns: LocalKanbanColumn[] = [
    { id: uuidv4(), title: colTitles.todo, position: 0, boardId: id, isCompleted: false, syncStatus: 'created' },
    { id: uuidv4(), title: colTitles.inProgress, position: 1, boardId: id, isCompleted: false, syncStatus: 'created' },
    { id: uuidv4(), title: colTitles.done, position: 2, boardId: id, isCompleted: true, syncStatus: 'created' },
  ];

  await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.syncQueue, async () => {
    await db.kanbanBoards.add(board);
    await db.kanbanColumns.bulkAdd(columns);

    // Queue board CREATE with local column IDs for reconciliation after sync
    // Backend createBoard creates default columns server-side, so we DON'T
    // queue separate KANBAN_COLUMN CREATEs. Instead, syncPush will reconcile
    // local column IDs with server column IDs by position after the board is created.
    await db.syncQueue.add({
      type: 'CREATE',
      entity: 'KANBAN_BOARD',
      entityId: id,
      userId,
      data: {
        id,
        title: data.title,
        description: data.description,
        columnTitles: data.columnTitles,
        _localColumnIds: columns.map(c => c.id),
      },
      createdAt: Date.now(),
    });
  });

  return board;
}

export async function createBoardFromTaskList(taskListId: string, columnTitles?: { todo: string; done: string }): Promise<KanbanBoard> {
  // Server-only — task list conversion requires backend logic
  const res = await api.post<KanbanBoard>('/kanban/boards/from-tasklist', { taskListId, columnTitles });
  return res.data;
}

export async function getBoard(boardId: string): Promise<KanbanBoard> {
  const res = await api.get<KanbanBoard>(`/kanban/boards/${boardId}`);
  return res.data;
}

export async function updateBoard(
  boardId: string,
  data: { title?: string; description?: string | null },
): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.kanbanBoards.update(boardId, { ...data, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_BOARD',
    entityId: boardId,
    userId,
    data,
    createdAt: Date.now(),
  });
}

export async function deleteBoard(boardId: string): Promise<void> {
  const userId = getUserId();

  await db.transaction('rw', db.kanbanBoards, db.kanbanColumns, db.kanbanCards, db.syncQueue, async () => {
    // Cascade delete columns and cards locally
    const columns = await db.kanbanColumns.where('boardId').equals(boardId).toArray();
    const columnIds = columns.map(c => c.id);
    if (columnIds.length > 0) {
      await db.kanbanCards.where('boardId').equals(boardId).delete();
      await db.kanbanColumns.where('boardId').equals(boardId).delete();
    }
    await db.kanbanBoards.delete(boardId);

    await db.syncQueue.add({
      type: 'DELETE',
      entity: 'KANBAN_BOARD',
      entityId: boardId,
      userId,
      data: {},
      createdAt: Date.now(),
    });
  });
}

// ── Columns (offline-first) ─────────────────────────────────────────────

export async function createColumn(boardId: string, title: string): Promise<LocalKanbanColumn> {
  const userId = getUserId();
  const id = uuidv4();

  // Get max position
  const existingCols = await db.kanbanColumns.where('boardId').equals(boardId).toArray();
  const maxPos = existingCols.reduce((max, c) => Math.max(max, c.position), -1);

  const column: LocalKanbanColumn = {
    id,
    title,
    position: maxPos + 1,
    boardId,
    isCompleted: false,
    syncStatus: 'created',
  };

  await db.transaction('rw', db.kanbanColumns, db.kanbanBoards, db.syncQueue, async () => {
    await db.kanbanColumns.add(column);

    // Update board column count
    const board = await db.kanbanBoards.get(boardId);
    if (board) {
      await db.kanbanBoards.update(boardId, { columnCount: (board.columnCount || 0) + 1 });
    }

    await db.syncQueue.add({
      type: 'CREATE',
      entity: 'KANBAN_COLUMN',
      entityId: id,
      userId,
      data: { id, boardId, title },
      createdAt: Date.now(),
    });
  });

  return column;
}

export async function updateColumn(
  columnId: string,
  data: { title?: string; isCompleted?: boolean },
): Promise<void> {
  const userId = getUserId();

  await db.kanbanColumns.update(columnId, { ...data, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_COLUMN',
    entityId: columnId,
    userId,
    data,
    createdAt: Date.now(),
  });
}

export async function reorderColumns(_boardId: string, columns: { id: string; position: number }[]): Promise<void> {
  const userId = getUserId();

  await db.transaction('rw', db.kanbanColumns, db.syncQueue, async () => {
    for (const { id, position } of columns) {
      await db.kanbanColumns.update(id, { position, syncStatus: 'updated' });
      await db.syncQueue.add({
        type: 'UPDATE',
        entity: 'KANBAN_COLUMN',
        entityId: id,
        userId,
        data: { position },
        createdAt: Date.now(),
      });
    }
  });
}

export async function deleteColumn(columnId: string): Promise<void> {
  const userId = getUserId();

  await db.transaction('rw', db.kanbanColumns, db.kanbanCards, db.kanbanBoards, db.syncQueue, async () => {
    const column = await db.kanbanColumns.get(columnId);
    if (!column) return;

    // Delete cards in this column
    await db.kanbanCards.where('columnId').equals(columnId).delete();
    await db.kanbanColumns.delete(columnId);

    // Update board counts
    const board = await db.kanbanBoards.get(column.boardId);
    if (board) {
      const remainingCols = await db.kanbanColumns.where('boardId').equals(column.boardId).count();
      const remainingCards = await db.kanbanCards.where('boardId').equals(column.boardId).count();
      await db.kanbanBoards.update(column.boardId, { columnCount: remainingCols, cardCount: remainingCards });
    }

    await db.syncQueue.add({
      type: 'DELETE',
      entity: 'KANBAN_COLUMN',
      entityId: columnId,
      userId,
      data: {},
      createdAt: Date.now(),
    });
  });
}

// ── Cards (offline-first) ───────────────────────────────────────────────

export async function createCard(
  columnId: string,
  data: { title: string; description?: string },
): Promise<LocalKanbanCard> {
  const userId = getUserId();
  const id = uuidv4();
  const now = new Date().toISOString();

  // Get column for boardId + max position
  const column = await db.kanbanColumns.get(columnId);
  if (!column) throw new Error('Column not found');

  const cardsInColumn = await db.kanbanCards.where('columnId').equals(columnId).toArray();
  const maxPos = cardsInColumn.reduce((max, c) => Math.max(max, c.position), -1);

  const card: LocalKanbanCard = {
    id,
    title: data.title,
    description: data.description || null,
    position: maxPos + 1,
    columnId,
    boardId: column.boardId,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    priority: null,
    noteId: null,
    noteLinkedById: null,
    note: null,
    commentCount: 0,
    createdAt: now,
    updatedAt: now,
    syncStatus: 'created',
  };

  await db.transaction('rw', db.kanbanCards, db.kanbanBoards, db.syncQueue, async () => {
    await db.kanbanCards.add(card);

    // Update board card count
    const board = await db.kanbanBoards.get(column.boardId);
    if (board) {
      await db.kanbanBoards.update(column.boardId, { cardCount: (board.cardCount || 0) + 1 });
    }

    await db.syncQueue.add({
      type: 'CREATE',
      entity: 'KANBAN_CARD',
      entityId: id,
      userId,
      data: { id, columnId, title: data.title, description: data.description },
      createdAt: Date.now(),
    });
  });

  return card;
}

export async function updateCard(
  cardId: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueDate?: string | null;
    priority?: KanbanCardPriority | null;
  },
): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.kanbanCards.update(cardId, { ...data, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_CARD',
    entityId: cardId,
    userId,
    data,
    createdAt: Date.now(),
  });
}

export async function moveCard(cardId: string, toColumnId: string, position: number): Promise<void> {
  const userId = getUserId();
  const now = new Date().toISOString();

  await db.kanbanCards.update(cardId, { columnId: toColumnId, position, updatedAt: now, syncStatus: 'updated' });
  await db.syncQueue.add({
    type: 'UPDATE',
    entity: 'KANBAN_CARD',
    entityId: cardId,
    userId,
    data: { columnId: toColumnId, position },
    createdAt: Date.now(),
  });
}

export async function deleteCard(cardId: string): Promise<void> {
  const userId = getUserId();

  const card = await db.kanbanCards.get(cardId);
  if (!card) return;

  await db.transaction('rw', db.kanbanCards, db.kanbanBoards, db.syncQueue, async () => {
    await db.kanbanCards.delete(cardId);

    // Update board card count
    const board = await db.kanbanBoards.get(card.boardId);
    if (board) {
      await db.kanbanBoards.update(card.boardId, { cardCount: Math.max(0, (board.cardCount || 0) - 1) });
    }

    await db.syncQueue.add({
      type: 'DELETE',
      entity: 'KANBAN_CARD',
      entityId: cardId,
      userId,
      data: { columnId: card.columnId },
      createdAt: Date.now(),
    });
  });
}

// ── Comments (server-only) ──────────────────────────────────────────────

export async function getComments(cardId: string): Promise<KanbanComment[]> {
  const res = await api.get<KanbanComment[]>(`/kanban/cards/${cardId}/comments`);
  return res.data;
}

export async function createComment(cardId: string, content: string): Promise<KanbanComment> {
  const res = await api.post<KanbanComment>(`/kanban/cards/${cardId}/comments`, { content });
  return res.data;
}

export async function deleteComment(commentId: string): Promise<void> {
  await api.delete(`/kanban/comments/${commentId}`);
}

// ── Card Activities (server-only) ───────────────────────────────────────

export async function getCardActivities(cardId: string): Promise<KanbanCardActivity[]> {
  const res = await api.get<KanbanCardActivity[]>(`/kanban/cards/${cardId}/activities`);
  return res.data;
}

// ── Cover Image (server-only) ───────────────────────────────────────────

export async function uploadCoverImage(boardId: string, file: File): Promise<{ coverImage: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post<{ coverImage: string }>(`/kanban/boards/${boardId}/cover`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function deleteCoverImage(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}/cover`);
}

// ── Board Chat (server-only) ────────────────────────────────────────────

export async function getBoardChat(boardId: string): Promise<KanbanBoardChatMessage[]> {
  const res = await api.get<KanbanBoardChatMessage[]>(`/kanban/boards/${boardId}/chat`);
  return res.data;
}

export async function sendBoardChatMessage(
  boardId: string,
  content: string,
): Promise<KanbanBoardChatMessage> {
  const res = await api.post<KanbanBoardChatMessage>(`/kanban/boards/${boardId}/chat`, { content });
  return res.data;
}

// ── Sharing (server-only) ───────────────────────────────────────────────

export async function shareBoard(
  boardId: string,
  email: string,
  permission: 'READ' | 'WRITE',
): Promise<SharedKanbanBoard> {
  const res = await api.post<SharedKanbanBoard>(`/share/kanbans/${boardId}`, { email, permission });
  return res.data;
}

export async function revokeShare(boardId: string, userId: string): Promise<void> {
  await api.delete(`/share/kanbans/${boardId}/${userId}`);
}

// ── Note Linking (server-only) ──────────────────────────────────────────

export async function checkNoteSharing(cardId: string, noteId: string): Promise<NoteSharingCheck> {
  const res = await api.get<NoteSharingCheck>(`/kanban/cards/${cardId}/check-note-sharing`, {
    params: { noteId },
  });
  return res.data;
}

export async function linkNoteToCard(
  cardId: string,
  noteId: string,
  shareWithUserIds?: string[],
): Promise<KanbanCard> {
  const res = await api.post<KanbanCard>(`/kanban/cards/${cardId}/link-note`, {
    noteId,
    shareWithUserIds,
  });
  return res.data;
}

export async function unlinkNoteFromCard(cardId: string): Promise<KanbanCard> {
  const res = await api.delete<KanbanCard>(`/kanban/cards/${cardId}/link-note`);
  return res.data;
}

export async function searchNotes(query: string): Promise<NoteSearchResult[]> {
  const res = await api.get<NoteSearchResult[]>('/kanban/notes/search', { params: { q: query } });
  return res.data;
}

// ── Note-Board Links (server-only) ──────────────────────────────────────

export interface LinkedBoardInfo {
  boardId: string;
  boardTitle: string;
  boardAvatarUrl: string | null;
  linkedAs: 'board' | 'card';
  cardIds: string[];
  cardTitles: string[];
}

export async function getLinkedBoardsForNote(noteId: string): Promise<LinkedBoardInfo[]> {
  const res = await api.get<LinkedBoardInfo[]>(`/kanban/notes/${noteId}/linked-boards`);
  return res.data;
}

// ── Board Note Linking (server-only) ────────────────────────────────────

export async function checkBoardNoteSharing(boardId: string, noteId: string): Promise<NoteSharingCheck> {
  const res = await api.get<NoteSharingCheck>(`/kanban/boards/${boardId}/check-note-sharing`, {
    params: { noteId },
  });
  return res.data;
}

export async function linkNoteToBoard(
  boardId: string,
  noteId: string,
  shareWithUserIds?: string[],
): Promise<{ noteId: string; noteLinkedById: string; note: { id: string; title: string; userId: string } }> {
  const res = await api.post(`/kanban/boards/${boardId}/link-note`, { noteId, shareWithUserIds });
  return res.data;
}

export async function unlinkNoteFromBoard(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}/link-note`);
}

// ── Board Avatar (server-only) ──────────────────────────────────────────

export async function uploadAvatar(boardId: string, file: File): Promise<{ avatarUrl: string }> {
  const formData = new FormData();
  formData.append('file', file);
  const res = await api.post<{ avatarUrl: string }>(`/kanban/boards/${boardId}/avatar`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data;
}

export async function deleteAvatar(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}/avatar`);
}

// ── Archived Cards (server-only) ────────────────────────────────────────

export async function getArchivedCards(boardId: string): Promise<ArchivedCard[]> {
  const res = await api.get<ArchivedCard[]>(`/kanban/boards/${boardId}/archived`);
  return res.data;
}

export async function unarchiveCard(cardId: string): Promise<void> {
  await api.post(`/kanban/cards/${cardId}/unarchive`);
}

// ── Task List Linking (server-only) ─────────────────────────────────────

export async function linkTaskList(boardId: string, taskListId: string): Promise<void> {
  await api.post(`/kanban/boards/${boardId}/link-tasklist`, { taskListId });
}

export async function unlinkTaskList(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}/link-tasklist`);
}

export async function searchTaskLists(query: string): Promise<TaskListSearchResult[]> {
  const res = await api.get<TaskListSearchResult[]>('/kanban/tasklists/search', { params: { q: query } });
  return res.data;
}
