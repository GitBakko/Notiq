import crypto from 'crypto';
import type {
  User,
  Note,
  Notebook,
  Tag,
  Attachment,
  Invitation,
  SharedNote,
  SharedNotebook,
  SharedTaskList,
  SharedKanbanBoard,
  KanbanBoard,
  KanbanColumn,
  KanbanCard,
  KanbanComment,
  KanbanCardActivity,
  KanbanReminder,
  KanbanBoardChat,
  Group,
  GroupMember,
  PendingGroupInvite,
  TaskList,
  TaskItem,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Counter for unique sequential values (emails, names, etc.)
// ---------------------------------------------------------------------------

let counter = 0;

function nextId(): number {
  counter += 1;
  return counter;
}

/** Reset the counter between test suites if needed. */
export function resetFactoryCounter(): void {
  counter = 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): Date {
  return new Date();
}

function tomorrow(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function makeUser(overrides: Partial<User> = {}): User {
  const n = nextId();
  return {
    id: crypto.randomUUID(),
    email: `user-${n}@test.com`,
    password: '$2b$10$hashedpasswordplaceholder',
    name: `User`,
    surname: `Test${n}`,
    gender: null,
    dateOfBirth: null,
    placeOfBirth: null,
    mobile: null,
    avatarUrl: null,
    color: '#10b981',
    resetToken: null,
    resetTokenExpiry: null,
    locale: 'en',
    emailNotificationsEnabled: true,
    createdAt: now(),
    lastActiveAt: now(),
    role: 'USER',
    isVerified: true,
    verificationToken: null,
    verificationTokenExpires: null,
    invitationCode: null,
    invitesAvailable: 2,
    tokenVersion: 0,
    ...overrides,
  };
}

export function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: crypto.randomUUID(),
    title: 'Test Note',
    content: '{}',
    searchText: null,
    notebookId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    isTrashed: false,
    reminderDate: null,
    isReminderDone: false,
    isPublic: false,
    shareId: null,
    isPinned: false,
    isVault: false,
    isEncrypted: false,
    noteType: 'NOTE',
    ydocState: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeNotebook(overrides: Partial<Notebook> = {}): Notebook {
  return {
    id: crypto.randomUUID(),
    name: 'Test Notebook',
    userId: crypto.randomUUID(),
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: crypto.randomUUID(),
    name: 'test-tag',
    userId: crypto.randomUUID(),
    isVault: false,
    ...overrides,
  };
}

export function makeKanbanBoard(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: crypto.randomUUID(),
    title: 'Test Board',
    description: null,
    coverImage: null,
    avatarUrl: null,
    noteId: null,
    noteLinkedById: null,
    taskListId: null,
    taskListLinkedById: null,
    ownerId: crypto.randomUUID(),
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeKanbanColumn(overrides: Partial<KanbanColumn> = {}): KanbanColumn {
  return {
    id: crypto.randomUUID(),
    title: 'To Do',
    position: 0,
    isCompleted: false,
    boardId: crypto.randomUUID(),
    ...overrides,
  };
}

export function makeKanbanCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: crypto.randomUUID(),
    title: 'Test Card',
    description: null,
    position: 0,
    columnId: crypto.randomUUID(),
    assigneeId: null,
    dueDate: null,
    priority: null,
    archivedAt: null,
    taskItemId: null,
    noteId: null,
    noteLinkedById: null,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeKanbanComment(overrides: Partial<KanbanComment> = {}): KanbanComment {
  return {
    id: crypto.randomUUID(),
    content: 'Test comment',
    cardId: crypto.randomUUID(),
    authorId: crypto.randomUUID(),
    createdAt: now(),
    ...overrides,
  };
}

export function makeKanbanReminder(overrides: Partial<KanbanReminder> = {}): KanbanReminder {
  return {
    id: crypto.randomUUID(),
    cardId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    boardId: crypto.randomUUID(),
    dueDate: tomorrow(),
    isDone: false,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: crypto.randomUUID(),
    name: 'Test Group',
    description: null,
    avatarUrl: null,
    ownerId: crypto.randomUUID(),
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeGroupMember(overrides: Partial<GroupMember> = {}): GroupMember {
  return {
    groupId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    joinedAt: now(),
    ...overrides,
  };
}

export function makeTaskList(overrides: Partial<TaskList> = {}): TaskList {
  return {
    id: crypto.randomUUID(),
    title: 'Test Task List',
    userId: crypto.randomUUID(),
    isTrashed: false,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeTaskItem(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: crypto.randomUUID(),
    taskListId: crypto.randomUUID(),
    text: 'Test item',
    isChecked: false,
    checkedByUserId: null,
    priority: 'MEDIUM',
    dueDate: null,
    position: 0,
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

export function makeSharedNote(overrides: Partial<SharedNote> = {}): SharedNote {
  return {
    id: crypto.randomUUID(),
    noteId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    permission: 'READ',
    status: 'PENDING',
    createdAt: now(),
    ...overrides,
  };
}

export function makeSharedNotebook(overrides: Partial<SharedNotebook> = {}): SharedNotebook {
  return {
    id: crypto.randomUUID(),
    notebookId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    permission: 'READ',
    status: 'PENDING',
    createdAt: now(),
    ...overrides,
  };
}

export function makeSharedTaskList(overrides: Partial<SharedTaskList> = {}): SharedTaskList {
  return {
    id: crypto.randomUUID(),
    taskListId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    permission: 'READ',
    status: 'PENDING',
    createdAt: now(),
    ...overrides,
  };
}

export function makeSharedKanbanBoard(overrides: Partial<SharedKanbanBoard> = {}): SharedKanbanBoard {
  return {
    id: crypto.randomUUID(),
    boardId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    permission: 'READ',
    status: 'PENDING',
    createdAt: now(),
    ...overrides,
  };
}

export function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
  return {
    id: crypto.randomUUID(),
    noteId: crypto.randomUUID(),
    url: '/uploads/test.png',
    filename: 'test.png',
    mimeType: 'image/png',
    size: 1024,
    version: 1,
    hash: null,
    isLatest: true,
    createdAt: now(),
    ...overrides,
  };
}

export function makeInvitation(overrides: Partial<Invitation> = {}): Invitation {
  return {
    id: crypto.randomUUID(),
    code: crypto.randomUUID(),
    creatorId: crypto.randomUUID(),
    usedById: null,
    usedAt: null,
    status: 'PENDING',
    createdAt: now(),
    ...overrides,
  };
}

export function makeKanbanCardActivity(overrides: Partial<KanbanCardActivity> = {}): KanbanCardActivity {
  return {
    id: crypto.randomUUID(),
    cardId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    action: 'CREATED',
    fromColumnTitle: null,
    toColumnTitle: null,
    metadata: null,
    createdAt: now(),
    ...overrides,
  };
}

export function makePendingGroupInvite(overrides: Partial<PendingGroupInvite> = {}): PendingGroupInvite {
  return {
    id: crypto.randomUUID(),
    groupId: crypto.randomUUID(),
    email: 'pending@test.com',
    invitedBy: crypto.randomUUID(),
    createdAt: now(),
    ...overrides,
  };
}

export function makeKanbanBoardChat(overrides: Partial<KanbanBoardChat> = {}): KanbanBoardChat {
  return {
    id: crypto.randomUUID(),
    boardId: crypto.randomUUID(),
    authorId: crypto.randomUUID(),
    content: 'Test chat message',
    createdAt: now(),
    ...overrides,
  };
}
