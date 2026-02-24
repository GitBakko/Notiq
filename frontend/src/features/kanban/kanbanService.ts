import api from '../../lib/api';
import type {
  KanbanBoard,
  KanbanBoardListItem,
  KanbanBoardChatMessage,
  KanbanCard,
  KanbanCardActivity,
  KanbanColumn,
  KanbanComment,
  NoteSharingCheck,
  NoteSearchResult,
  SharedKanbanBoard,
} from './types';

// ── Boards ──────────────────────────────────────────────────────────────

export async function listBoards(): Promise<KanbanBoardListItem[]> {
  const res = await api.get<KanbanBoardListItem[]>('/kanban/boards');
  return res.data;
}

export async function createBoard(data: { title: string; description?: string }): Promise<KanbanBoard> {
  const res = await api.post<KanbanBoard>('/kanban/boards', data);
  return res.data;
}

export async function getBoard(boardId: string): Promise<KanbanBoard> {
  const res = await api.get<KanbanBoard>(`/kanban/boards/${boardId}`);
  return res.data;
}

export async function updateBoard(
  boardId: string,
  data: { title?: string; description?: string | null },
): Promise<KanbanBoard> {
  const res = await api.put<KanbanBoard>(`/kanban/boards/${boardId}`, data);
  return res.data;
}

export async function deleteBoard(boardId: string): Promise<void> {
  await api.delete(`/kanban/boards/${boardId}`);
}

// ── Columns ─────────────────────────────────────────────────────────────

export async function createColumn(boardId: string, title: string): Promise<KanbanColumn> {
  const res = await api.post<KanbanColumn>(`/kanban/boards/${boardId}/columns`, { title });
  return res.data;
}

export async function updateColumn(columnId: string, title: string): Promise<KanbanColumn> {
  const res = await api.put<KanbanColumn>(`/kanban/columns/${columnId}`, { title });
  return res.data;
}

export async function reorderColumns(columns: { id: string; position: number }[]): Promise<void> {
  await api.patch('/kanban/columns/reorder', { columns });
}

export async function deleteColumn(columnId: string): Promise<void> {
  await api.delete(`/kanban/columns/${columnId}`);
}

// ── Cards ───────────────────────────────────────────────────────────────

export async function createCard(
  columnId: string,
  data: { title: string; description?: string },
): Promise<KanbanCard> {
  const res = await api.post<KanbanCard>(`/kanban/columns/${columnId}/cards`, data);
  return res.data;
}

export async function updateCard(
  cardId: string,
  data: {
    title?: string;
    description?: string | null;
    assigneeId?: string | null;
    dueDate?: string | null;
  },
): Promise<KanbanCard> {
  const res = await api.put<KanbanCard>(`/kanban/cards/${cardId}`, data);
  return res.data;
}

export async function moveCard(cardId: string, toColumnId: string, position: number): Promise<void> {
  await api.put(`/kanban/cards/${cardId}/move`, { toColumnId, position });
}

export async function deleteCard(cardId: string): Promise<void> {
  await api.delete(`/kanban/cards/${cardId}`);
}

// ── Comments ────────────────────────────────────────────────────────────

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

// ── Card Activities ────────────────────────────────────────────────────

export async function getCardActivities(cardId: string): Promise<KanbanCardActivity[]> {
  const res = await api.get<KanbanCardActivity[]>(`/kanban/cards/${cardId}/activities`);
  return res.data;
}

// ── Cover Image ────────────────────────────────────────────────────────

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

// ── Board Chat ─────────────────────────────────────────────────────────

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

// ── Sharing ─────────────────────────────────────────────────────────────

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

// ── Note Linking ──────────────────────────────────────────────────────────

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

// ── Note-Board Links ──────────────────────────────────────────────────────

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

// ── Board Note Linking ───────────────────────────────────────────────────

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

// ── Board Avatar ─────────────────────────────────────────────────────────

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
