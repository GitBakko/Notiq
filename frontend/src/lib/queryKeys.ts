export const queryKeys = {
  notes: {
    all: ['notes'] as const,
    detail: (id: string) => ['note', id] as const,
  },
  notebooks: {
    all: ['notebooks'] as const,
    shareCounts: ['notebook-share-counts'] as const,
  },
  tags: {
    all: ['tags'] as const,
  },
  taskLists: {
    all: ['task-lists'] as const,
    detail: (id: string) => ['taskList', id] as const,
  },
  kanban: {
    boards: ['kanban-boards'] as const,
    board: (id: string) => ['kanban-board', id] as const,
    boardChat: (boardId: string) => ['kanban-board-chat', boardId] as const,
    comments: (cardId: string) => ['kanban-comments', cardId] as const,
    cardActivities: (cardId: string) => ['kanban-card-activities', cardId] as const,
    archivedCards: (boardId: string) => ['kanban-archived-cards', boardId] as const,
    noteSearch: (query: string) => ['kanban-note-search', query] as const,
    taskListSearch: (query: string) => ['kanban-tasklist-search', query] as const,
    linkedBoards: (noteId: string) => ['kanban-linked-boards', noteId] as const,
    reminders: ['kanban-reminders'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
  },
  groups: {
    all: ['groups'] as const,
    forSharing: ['groups-for-sharing'] as const,
  },
  ai: {
    status: ['ai-status'] as const,
    history: (noteId: string) => ['ai-history', noteId] as const,
  },
  chat: (noteId: string) => ['chat', noteId] as const,
  search: (query: string) => ['search', query] as const,
} as const;
