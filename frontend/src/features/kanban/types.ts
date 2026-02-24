export interface KanbanBoard {
  id: string;
  title: string;
  description: string | null;
  coverImage: string | null;
  avatarUrl: string | null;
  noteId: string | null;
  noteLinkedById: string | null;
  note: { id: string; title: string; userId: string } | null;
  ownerId: string;
  owner?: { id: string; name: string | null; email: string; color: string | null };
  columns: KanbanColumn[];
  shares?: SharedKanbanBoard[];
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoardListItem {
  id: string;
  title: string;
  description: string | null;
  coverImage: string | null;
  avatarUrl: string | null;
  ownerId: string;
  owner?: { id: string; name: string | null; email: string };
  columnCount: number;
  cardCount: number;
  ownership: 'owned' | 'shared';
  permission?: 'READ' | 'WRITE';
  createdAt: string;
  updatedAt: string;
}

export interface KanbanColumn {
  id: string;
  title: string;
  position: number;
  boardId: string;
  cards: KanbanCard[];
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string | null;
  position: number;
  columnId: string;
  assigneeId: string | null;
  assignee: { id: string; name: string | null; email: string; color: string | null } | null;
  dueDate: string | null;
  noteId: string | null;
  noteLinkedById: string | null;
  note: { id: string; title: string; userId: string } | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanComment {
  id: string;
  content: string;
  cardId: string;
  authorId: string;
  author: { id: string; name: string | null; email: string; color: string | null };
  createdAt: string;
}

export type KanbanCardActionType =
  | 'CREATED'
  | 'MOVED'
  | 'UPDATED'
  | 'ASSIGNED'
  | 'UNASSIGNED'
  | 'DUE_DATE_SET'
  | 'DUE_DATE_REMOVED'
  | 'NOTE_LINKED'
  | 'NOTE_UNLINKED'
  | 'DELETED';

export interface KanbanCardActivity {
  id: string;
  cardId: string;
  userId: string;
  user: { id: string; name: string | null; email: string; color: string | null; avatarUrl: string | null };
  action: KanbanCardActionType;
  fromColumnTitle: string | null;
  toColumnTitle: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SharedKanbanBoard {
  id: string;
  userId: string;
  user: { id: string; name: string | null; email: string };
  permission: 'READ' | 'WRITE';
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
}

export interface BoardPresenceUser {
  id: string;
  name: string | null;
  color: string | null;
  avatarUrl: string | null;
}

export interface KanbanBoardChatMessage {
  id: string;
  boardId: string;
  authorId: string;
  author: { id: string; name: string | null; email: string; color: string | null; avatarUrl: string | null };
  content: string;
  createdAt: string;
}

export interface NoteSharingCheck {
  noteTitle: string;
  noteOwnerId: string;
  alreadyFullyShared: boolean;
  usersWithAccess: { id: string; name: string | null; email: string }[];
  usersWithoutAccess: { id: string; name: string | null; email: string }[];
}

export interface NoteSearchResult {
  id: string;
  title: string;
  notebookId: string;
  notebook: { id: string; name: string } | null;
  updatedAt: string;
}

/** Column keys stored in DB mapped to i18n translation keys */
export const DEFAULT_COLUMN_KEYS: Record<string, string> = {
  TODO: 'kanban.column.todo',
  IN_PROGRESS: 'kanban.column.inProgress',
  DONE: 'kanban.column.done',
};

export type KanbanSSEEvent =
  | { type: 'connected' }
  | { type: 'card:moved'; boardId: string; cardId: string; toColumnId: string; position: number }
  | { type: 'card:created'; boardId: string; card: KanbanCard }
  | { type: 'card:updated'; boardId: string; card: KanbanCard }
  | { type: 'card:deleted'; boardId: string; cardId: string }
  | { type: 'column:created'; boardId: string; column: KanbanColumn }
  | { type: 'column:updated'; boardId: string; column: KanbanColumn }
  | { type: 'column:deleted'; boardId: string; columnId: string }
  | { type: 'columns:reordered'; boardId: string; columns: { id: string; position: number }[] }
  | { type: 'comment:added'; boardId: string; cardId: string; comment: KanbanComment }
  | { type: 'chat:message'; boardId: string; message: KanbanBoardChatMessage }
  | { type: 'presence:update'; boardId: string; users: BoardPresenceUser[] };
