import Dexie, { type Table } from 'dexie';

export interface LocalNote {
  id: string;
  title: string;
  content: string;
  searchText?: string;
  notebookId: string;
  userId: string;
  isTrashed: boolean;
  createdAt: string;
  updatedAt: string;
  tags: { tag: { id: string; name: string } }[];
  attachments: {
    id: string;
    url: string;
    filename: string;
    mimeType: string;
    size: number;
    version?: number;
    hash?: string;
    isLatest?: boolean;
  }[];
  reminderDate?: string | null;
  isReminderDone?: boolean;
  isPublic?: boolean;
  shareId?: string | null;
  isPinned?: boolean;
  isVault?: boolean;
  isEncrypted?: boolean;
  noteType?: 'NOTE' | 'CREDENTIAL';
  sharedWith?: {
    id: string;
    userId: string;
    permission: 'READ' | 'WRITE';
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    user: { id: string; name: string | null; email: string; avatarUrl?: string | null };
  }[];
  ownership?: 'owned' | 'shared';
  sharedPermission?: 'READ' | 'WRITE' | null;
  sharedByUser?: { id: string; name: string | null; email: string; avatarUrl?: string | null } | null;
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalNotebook {
  id: string;
  name: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalTag {
  id: string;
  name: string;
  userId: string;
  isVault?: boolean;
  syncStatus: 'synced' | 'created' | 'updated';
  _count?: {
    notes: number;
  };
}

export interface LocalTaskList {
  id: string;
  title: string;
  userId: string;
  createdAt: string;
  updatedAt: string;
  isTrashed: boolean;
  ownership?: 'owned' | 'shared';
  sharedPermission?: 'READ' | 'WRITE' | null;
  sharedByUser?: { id: string; name: string | null; email: string } | null;
  sharedWith?: {
    id: string;
    userId: string;
    permission: 'READ' | 'WRITE';
    status: 'PENDING' | 'ACCEPTED' | 'DECLINED';
    user: { id: string; name: string | null; email: string; avatarUrl?: string | null };
  }[];
  items?: LocalTaskItem[];
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalTaskItem {
  id: string;
  taskListId: string;
  text: string;
  isChecked: boolean;
  checkedByUser?: { id: string; name: string | null; email: string; color: string | null; avatarUrl?: string | null } | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  dueDate?: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalKanbanBoard {
  id: string;
  title: string;
  description: string | null;
  coverImage: string | null;
  avatarUrl: string | null;
  ownerId: string;
  owner?: { id: string; name: string | null; email: string };
  columnCount: number;
  cardCount: number;
  shareCount?: number;
  shares?: { userId: string; permission: 'READ' | 'WRITE'; user: { id: string; name: string | null; email: string; avatarUrl?: string | null } }[];
  ownership: 'owned' | 'shared';
  permission?: 'READ' | 'WRITE';
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalKanbanColumn {
  id: string;
  title: string;
  position: number;
  boardId: string;
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface LocalKanbanCard {
  id: string;
  title: string;
  description: string | null;
  position: number;
  columnId: string;
  boardId: string; // denormalized for efficient queries
  assigneeId: string | null;
  assignee: { id: string; name: string | null; email: string; color: string | null; avatarUrl: string | null } | null;
  dueDate: string | null;
  priority: 'STANDBY' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  noteId: string | null;
  noteLinkedById: string | null;
  note: { id: string; title: string; userId: string } | null;
  commentCount: number;
  createdAt: string;
  updatedAt: string;
  syncStatus: 'synced' | 'created' | 'updated';
}

export interface SyncQueueItem {
  id?: number; // Auto-increment
  type: 'CREATE' | 'UPDATE' | 'DELETE';
  entity: 'NOTE' | 'NOTEBOOK' | 'TAG' | 'TASK_LIST' | 'TASK_ITEM' | 'KANBAN_BOARD' | 'KANBAN_COLUMN' | 'KANBAN_CARD';
  entityId: string;
  userId: string; // Added for data isolation
  data?: Record<string, unknown>;
  createdAt: number;
}

class AppDatabase extends Dexie {
  notes!: Table<LocalNote>;
  notebooks!: Table<LocalNotebook>;
  tags!: Table<LocalTag>;
  taskLists!: Table<LocalTaskList>;
  taskItems!: Table<LocalTaskItem>;
  kanbanBoards!: Table<LocalKanbanBoard>;
  kanbanColumns!: Table<LocalKanbanColumn>;
  kanbanCards!: Table<LocalKanbanCard>;
  syncQueue!: Table<SyncQueueItem>;

  constructor() {
    super('NotiqDB');
    this.version(1).stores({
      notes: 'id, notebookId, updatedAt, syncStatus, isTrashed',
      notebooks: 'id, name, updatedAt, syncStatus',
      tags: 'id, name, syncStatus',
      syncQueue: '++id, type, entity, createdAt'
    });

    this.version(2).stores({
      notes: 'id, notebookId, updatedAt, syncStatus, isTrashed, reminderDate, isReminderDone',
    });

    this.version(3).stores({
      notes: 'id, notebookId, updatedAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId',
    });

    this.version(4).stores({
      notes: 'id, notebookId, updatedAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned',
    });

    this.version(5).stores({
      notes: 'id, notebookId, updatedAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned, isVault, isEncrypted',
    });

    this.version(6).stores({
      notes: 'id, notebookId, updatedAt, createdAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned, isVault, isEncrypted',
    });

    this.version(7).stores({
      tags: 'id, name, syncStatus, isVault',
    });

    this.version(8).stores({
      notes: 'id, notebookId, userId, updatedAt, createdAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned, isVault, isEncrypted',
      notebooks: 'id, name, userId, updatedAt, syncStatus',
      tags: 'id, name, userId, syncStatus, isVault',
    });

    this.version(9).stores({
      syncQueue: '++id, type, entity, userId, createdAt'
    });

    // v10: Add searchText field for faster offline search (plain text, no JSON parsing)
    this.version(10).stores({
      notes: 'id, notebookId, userId, updatedAt, createdAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned, isVault, isEncrypted',
    });

    // v11: Add ownership field to distinguish shared notes from personal notes
    this.version(11).stores({
      notes: 'id, notebookId, userId, updatedAt, createdAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned, isVault, isEncrypted, ownership',
    }).upgrade(tx => {
      return tx.table('notes').toCollection().modify(note => {
        note.ownership = 'owned';
        note.sharedPermission = null;
        note.sharedByUser = null;
      });
    });

    // v12: Add noteType field for credential notes in vault
    this.version(12).stores({
      notes: 'id, notebookId, userId, updatedAt, createdAt, syncStatus, isTrashed, reminderDate, isReminderDone, isPublic, shareId, isPinned, isVault, isEncrypted, ownership, noteType',
    }).upgrade(tx => {
      return tx.table('notes').toCollection().modify(note => {
        note.noteType = 'NOTE';
      });
    });

    // v13: Add taskLists and taskItems tables for task list feature
    this.version(13).stores({
      taskLists: 'id, userId, updatedAt, syncStatus, isTrashed',
      taskItems: 'id, taskListId, updatedAt, syncStatus, position',
    });

    // v14: Add kanbanBoards, kanbanColumns, kanbanCards tables for kanban offline sync
    this.version(14).stores({
      kanbanBoards: 'id, ownerId, updatedAt, syncStatus, ownership',
      kanbanColumns: 'id, boardId, position, syncStatus',
      kanbanCards: 'id, columnId, boardId, position, updatedAt, syncStatus',
    });
  }
}

export const db = new AppDatabase();

