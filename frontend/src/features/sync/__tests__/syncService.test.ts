import { describe, it, expect, beforeEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// vi.hoisted() — variables available inside vi.mock() factory functions
// vi.mock calls are hoisted to the top of the file, so they can only reference
// variables created via vi.hoisted().
// ---------------------------------------------------------------------------

const { mockDb, mockApi, mockAuthStore } = vi.hoisted(() => {
  /**
   * Creates a chainable Dexie-like table mock.
   * Supports .where().equals().toArray(), .where().notEqual().toArray(),
   * .where().equals().filter().toArray(), .where().equals().delete(),
   * .filter().toArray(), .orderBy().toArray(), .and(fn).toArray(), etc.
   */
  const createTable = () => {
    const table: Record<string, any> = {
      where: vi.fn().mockImplementation(() => table),
      equals: vi.fn().mockImplementation(() => table),
      notEqual: vi.fn().mockImplementation(() => table),
      and: vi.fn().mockImplementation((fn: any) => {
        table._andFn = fn;
        return table;
      }),
      filter: vi.fn().mockImplementation((fn: any) => {
        table._filterFn = fn;
        return table;
      }),
      toArray: vi.fn().mockResolvedValue([]),
      bulkPut: vi.fn().mockResolvedValue(undefined),
      bulkDelete: vi.fn().mockResolvedValue(undefined),
      bulkGet: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
      delete: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(1),
      orderBy: vi.fn().mockImplementation(() => table),
    };
    return table;
  };

  const mockDb = {
    notes: createTable(),
    notebooks: createTable(),
    tags: createTable(),
    taskLists: createTable(),
    taskItems: createTable(),
    kanbanBoards: createTable(),
    kanbanColumns: createTable(),
    kanbanCards: createTable(),
    syncQueue: createTable(),
    // Dexie transaction: db.transaction('rw', db.table1, db.table2, async () => { ... })
    // The callback is always the LAST argument.
    transaction: vi.fn(async (...args: unknown[]) => {
      const fn = args[args.length - 1];
      if (typeof fn === 'function') return (fn as () => unknown)();
    }),
  };

  const mockApi = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };

  const mockAuthStore = {
    getState: vi.fn(() => ({ user: { id: 'user-1' } })),
  };

  return { mockDb, mockApi, mockAuthStore };
});

// ---------------------------------------------------------------------------
// vi.mock — uses the hoisted variables
// ---------------------------------------------------------------------------

vi.mock('../../../lib/db', () => ({ db: mockDb }));
vi.mock('../../../lib/api', () => ({ default: mockApi }));
vi.mock('../../../store/authStore', () => ({ useAuthStore: mockAuthStore }));

// ---------------------------------------------------------------------------
// Import the module under test (AFTER mocks are registered)
// ---------------------------------------------------------------------------

import { syncPull, syncPush } from '../syncService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset all mock return values to empty defaults */
const resetAllTableMocks = () => {
  for (const key of Object.keys(mockDb)) {
    const table = (mockDb as Record<string, any>)[key];
    if (table && typeof table === 'object' && 'toArray' in table) {
      // Reset chainable methods to return `table` itself
      table.where.mockImplementation(() => table);
      table.equals.mockImplementation(() => table);
      table.notEqual.mockImplementation(() => table);
      table.and.mockImplementation((fn: any) => { table._andFn = fn; return table; });
      table.filter.mockImplementation((fn: any) => { table._filterFn = fn; return table; });
      table.orderBy.mockImplementation(() => table);
      // Reset terminal methods
      table.toArray.mockResolvedValue([]);
      table.bulkPut.mockResolvedValue(undefined);
      table.bulkDelete.mockResolvedValue(undefined);
      table.bulkGet.mockResolvedValue([]);
      table.get.mockResolvedValue(null);
      table.count.mockResolvedValue(0);
      table.delete.mockResolvedValue(undefined);
      table.update.mockResolvedValue(1);
    }
  }
  // Reset transaction mock
  mockDb.transaction.mockImplementation(async (...args: unknown[]) => {
    const fn = args[args.length - 1];
    if (typeof fn === 'function') return (fn as () => unknown)();
  });
  // Reset auth store
  mockAuthStore.getState.mockReturnValue({ user: { id: 'user-1' } });
};

beforeEach(() => {
  vi.clearAllMocks();
  resetAllTableMocks();
});

// ===================================================================
// syncPull
// ===================================================================
describe('syncPull', () => {
  // -----------------------------------------------------------------
  // Notebooks
  // -----------------------------------------------------------------
  describe('notebooks', () => {
    it('pulls notebooks from server and stores in Dexie', async () => {
      const serverNotebooks = [
        { id: 'nb-1', name: 'Work', userId: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'nb-2', name: 'Personal', userId: 'user-1', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notebooks') return Promise.resolve({ data: serverNotebooks });
        return Promise.resolve({ data: [] });
      });

      // No dirty notebooks, no local synced
      let notebookToArrayCallCount = 0;
      mockDb.notebooks.toArray.mockImplementation(() => {
        notebookToArrayCallCount++;
        return Promise.resolve([]);
      });

      await syncPull();

      expect(mockApi.get).toHaveBeenCalledWith('/notebooks');
      expect(mockDb.notebooks.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'nb-1', name: 'Work', syncStatus: 'synced' }),
          expect.objectContaining({ id: 'nb-2', name: 'Personal', syncStatus: 'synced' }),
        ]),
      );
    });

    it('preserves dirty notebooks during pull (local wins temporarily)', async () => {
      const serverNotebooks = [
        { id: 'nb-1', name: 'Server Name', userId: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
        { id: 'nb-2', name: 'Clean', userId: 'user-1', createdAt: '2026-01-02', updatedAt: '2026-01-02' },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notebooks') return Promise.resolve({ data: serverNotebooks });
        return Promise.resolve({ data: [] });
      });

      let notebookToArrayCallCount = 0;
      mockDb.notebooks.toArray.mockImplementation(() => {
        notebookToArrayCallCount++;
        if (notebookToArrayCallCount === 1) {
          // Dirty notebook nb-1 exists locally
          return Promise.resolve([{ id: 'nb-1', name: 'Local Edit', syncStatus: 'updated' }]);
        }
        return Promise.resolve([]);
      });

      await syncPull();

      // bulkPut should only contain nb-2 (nb-1 is dirty, filtered out)
      const bulkPutCall = mockDb.notebooks.bulkPut.mock.calls[0]?.[0];
      expect(bulkPutCall).toHaveLength(1);
      expect(bulkPutCall[0]).toEqual(expect.objectContaining({ id: 'nb-2' }));
    });

    it('deletes synced notebooks missing from server', async () => {
      const serverNotebooks = [
        { id: 'nb-1', name: 'Kept', userId: 'user-1', createdAt: '2026-01-01', updatedAt: '2026-01-01' },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notebooks') return Promise.resolve({ data: serverNotebooks });
        return Promise.resolve({ data: [] });
      });

      let notebookToArrayCallCount = 0;
      mockDb.notebooks.toArray.mockImplementation(() => {
        notebookToArrayCallCount++;
        if (notebookToArrayCallCount === 1) return Promise.resolve([]); // no dirty
        if (notebookToArrayCallCount === 2) {
          // Local has nb-1 and nb-old (synced), server only has nb-1
          return Promise.resolve([
            { id: 'nb-1', syncStatus: 'synced' },
            { id: 'nb-old', syncStatus: 'synced' },
          ]);
        }
        return Promise.resolve([]);
      });

      await syncPull();

      expect(mockDb.notebooks.bulkDelete).toHaveBeenCalledWith(['nb-old']);
    });
  });

  // -----------------------------------------------------------------
  // Notes
  // -----------------------------------------------------------------
  describe('notes', () => {
    it('pulls notes and preserves local content field', async () => {
      const serverNotes = [
        {
          id: 'note-1', title: 'Test', notebookId: 'nb-1', userId: 'user-1',
          isTrashed: false, createdAt: '2026-01-01', updatedAt: '2026-01-01',
          tags: [], attachments: [],
          // Server does NOT send content (lightweight response)
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notes?includeTrashed=true') return Promise.resolve({ data: serverNotes });
        return Promise.resolve({ data: [] });
      });

      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);

      // bulkGet for preserving local content
      mockDb.notes.bulkGet.mockResolvedValue([
        { id: 'note-1', content: '<p>My local content</p>' },
      ]);

      await syncPull();

      const bulkPutCall = mockDb.notes.bulkPut.mock.calls[0]?.[0];
      expect(bulkPutCall).toBeDefined();
      expect(bulkPutCall[0]).toEqual(expect.objectContaining({
        id: 'note-1',
        content: '<p>My local content</p>',
        ownership: 'owned',
        syncStatus: 'synced',
      }));
    });

    it('prevents zombie resurrection for deleted notes', async () => {
      const serverNotes = [
        {
          id: 'note-zombie', title: 'Zombie', notebookId: 'nb-1', userId: 'user-1',
          isTrashed: false, createdAt: '2026-01-01', updatedAt: '2026-01-01',
          tags: [], attachments: [],
        },
        {
          id: 'note-alive', title: 'Alive', notebookId: 'nb-1', userId: 'user-1',
          isTrashed: false, createdAt: '2026-01-01', updatedAt: '2026-01-01',
          tags: [], attachments: [],
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notes?includeTrashed=true') return Promise.resolve({ data: serverNotes });
        return Promise.resolve({ data: [] });
      });

      // No dirty notes
      mockDb.notes.toArray.mockResolvedValue([]);

      // syncQueue has a pending DELETE for note-zombie
      mockDb.syncQueue.toArray.mockResolvedValue([
        { id: 99, type: 'DELETE', entity: 'NOTE', entityId: 'note-zombie', userId: 'user-1', createdAt: Date.now() },
      ]);

      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      // note-zombie should NOT be in the bulkPut call
      const notesBulkPutCall = mockDb.notes.bulkPut.mock.calls[0]?.[0];
      if (notesBulkPutCall) {
        const ids = notesBulkPutCall.map((n: { id: string }) => n.id);
        expect(ids).not.toContain('note-zombie');
        expect(ids).toContain('note-alive');
      }
    });

    it('deletes synced owned notes missing from server', async () => {
      // Server has note-1 only
      const serverNotes = [
        {
          id: 'note-1', title: 'Kept', notebookId: 'nb-1', userId: 'user-1',
          isTrashed: false, createdAt: '2026-01-01', updatedAt: '2026-01-01',
          tags: [], attachments: [],
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notes?includeTrashed=true') return Promise.resolve({ data: serverNotes });
        return Promise.resolve({ data: [] });
      });

      let notesTransactionToArrayCalls = 0;
      mockDb.notes.toArray.mockImplementation(() => {
        notesTransactionToArrayCalls++;
        if (notesTransactionToArrayCalls === 1) return Promise.resolve([]); // dirty
        if (notesTransactionToArrayCalls === 2) {
          // allLocalSyncedNotes — owned synced notes
          return Promise.resolve([
            { id: 'note-1', ownership: 'owned', syncStatus: 'synced' },
            { id: 'note-gone', ownership: 'owned', syncStatus: 'synced' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockDb.syncQueue.toArray.mockResolvedValue([]); // no pending deletes
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      expect(mockDb.notes.bulkDelete).toHaveBeenCalledWith(['note-gone']);
    });
  });

  // -----------------------------------------------------------------
  // Shared Notes
  // -----------------------------------------------------------------
  describe('shared notes', () => {
    it('pulls shared notes with ownership="shared"', async () => {
      const sharedNotes = [
        {
          id: 'shared-1', title: 'Shared Note', notebookId: 'nb-other', userId: 'user-2',
          isTrashed: false, createdAt: '2026-01-01', updatedAt: '2026-01-01',
          tags: [], attachments: [],
          _sharedPermission: 'WRITE' as const,
          user: { id: 'user-2', name: 'Other', email: 'other@test.com' },
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/share/notes/accepted') return Promise.resolve({ data: sharedNotes });
        return Promise.resolve({ data: [] });
      });

      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      // Find the bulkPut call for shared notes
      const allBulkPutCalls = mockDb.notes.bulkPut.mock.calls;
      const sharedBulkPutCall = allBulkPutCalls.find(
        (call: unknown[]) => (call[0] as any[])?.some?.((n: any) => n.ownership === 'shared'),
      );

      expect(sharedBulkPutCall).toBeDefined();
      expect(sharedBulkPutCall![0][0]).toEqual(expect.objectContaining({
        id: 'shared-1',
        ownership: 'shared',
        sharedPermission: 'WRITE',
        syncStatus: 'synced',
      }));
    });

    it('removes shared notes no longer in server response (revoked)', async () => {
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/share/notes/accepted') return Promise.resolve({ data: [] }); // nothing shared anymore
        return Promise.resolve({ data: [] });
      });

      let toArrayCallIndex = 0;
      mockDb.notes.toArray.mockImplementation(() => {
        toArrayCallIndex++;
        // Notes tx: 2 calls (dirty, allLocalSynced)
        // Shared tx: 1 call (localShared)
        if (toArrayCallIndex === 3) {
          return Promise.resolve([
            { id: 'was-shared', ownership: 'shared', syncStatus: 'synced' },
          ]);
        }
        return Promise.resolve([]);
      });

      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      expect(mockDb.notes.bulkDelete).toHaveBeenCalledWith(['was-shared']);
    });
  });

  // -----------------------------------------------------------------
  // Task Lists
  // -----------------------------------------------------------------
  describe('task lists', () => {
    it('pulls task lists with zombie prevention', async () => {
      const serverTaskLists = [
        {
          id: 'tl-1', title: 'Todo', userId: 'user-1', isTrashed: false,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
          items: [{ id: 'ti-1', taskListId: 'tl-1', text: 'Buy milk', isChecked: false, priority: 'LOW', position: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' }],
        },
        {
          id: 'tl-zombie', title: 'Zombie List', userId: 'user-1', isTrashed: false,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
          items: [],
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/tasklists') return Promise.resolve({ data: serverTaskLists });
        return Promise.resolve({ data: [] });
      });

      // No dirty task lists
      mockDb.taskLists.toArray.mockResolvedValue([]);

      // syncQueue: pending DELETE for tl-zombie
      mockDb.syncQueue.toArray.mockResolvedValue([
        { id: 10, type: 'DELETE', entity: 'TASK_LIST', entityId: 'tl-zombie', userId: 'user-1', createdAt: Date.now() },
      ]);

      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      // tl-zombie should be filtered out by zombie prevention
      const taskListsBulkPut = mockDb.taskLists.bulkPut.mock.calls[0]?.[0];
      if (taskListsBulkPut) {
        const ids = taskListsBulkPut.map((tl: { id: string }) => tl.id);
        expect(ids).toContain('tl-1');
        expect(ids).not.toContain('tl-zombie');
      }
    });

    it('syncs task items for each pulled task list', async () => {
      const serverTaskLists = [
        {
          id: 'tl-1', title: 'Shopping', userId: 'user-1', isTrashed: false,
          createdAt: '2026-01-01', updatedAt: '2026-01-01',
          items: [
            { id: 'ti-1', taskListId: 'tl-1', text: 'Eggs', isChecked: false, priority: 'LOW', position: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
            { id: 'ti-2', taskListId: 'tl-1', text: 'Bread', isChecked: true, priority: 'MEDIUM', position: 1, createdAt: '2026-01-01', updatedAt: '2026-01-01' },
          ],
        },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/tasklists') return Promise.resolve({ data: serverTaskLists });
        return Promise.resolve({ data: [] });
      });

      mockDb.taskLists.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      expect(mockDb.taskItems.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'ti-1', text: 'Eggs', syncStatus: 'synced' }),
          expect.objectContaining({ id: 'ti-2', text: 'Bread', syncStatus: 'synced' }),
        ]),
      );
    });
  });

  // -----------------------------------------------------------------
  // Kanban Boards
  // -----------------------------------------------------------------
  describe('kanban boards', () => {
    it('pulls kanban boards and their details (columns + cards)', async () => {
      const boardsList = [
        {
          id: 'kb-1', title: 'Project Board', description: null, coverImage: null,
          avatarUrl: null, ownerId: 'user-1', columnCount: 1, cardCount: 1,
          ownership: 'owned' as const, createdAt: '2026-01-01', updatedAt: '2026-01-01',
        },
      ];

      const boardDetail = {
        id: 'kb-1', title: 'Project Board', description: null, coverImage: null,
        avatarUrl: null, ownerId: 'user-1',
        columns: [
          {
            id: 'col-1', title: 'Todo', position: 0, boardId: 'kb-1', isCompleted: false,
            cards: [
              {
                id: 'card-1', title: 'Task A', description: null, position: 0,
                columnId: 'col-1', assigneeId: null, assignee: null, dueDate: null,
                priority: null, noteId: null, noteLinkedById: null, note: null,
                commentCount: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01',
              },
            ],
          },
        ],
        createdAt: '2026-01-01', updatedAt: '2026-01-01',
      };

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/kanban/boards') return Promise.resolve({ data: boardsList });
        if (url === '/kanban/boards/kb-1') return Promise.resolve({ data: boardDetail });
        return Promise.resolve({ data: [] });
      });

      mockDb.kanbanBoards.toArray.mockResolvedValue([]);
      mockDb.kanbanColumns.toArray.mockResolvedValue([]);
      mockDb.kanbanCards.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      await syncPull();

      // Board should be stored
      expect(mockDb.kanbanBoards.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'kb-1', syncStatus: 'synced' }),
        ]),
      );

      // Column should be stored
      expect(mockDb.kanbanColumns.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'col-1', title: 'Todo', boardId: 'kb-1', syncStatus: 'synced' }),
        ]),
      );

      // Card should be stored
      expect(mockDb.kanbanCards.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'card-1', title: 'Task A', boardId: 'kb-1', syncStatus: 'synced' }),
        ]),
      );
    });
  });

  // -----------------------------------------------------------------
  // Tags
  // -----------------------------------------------------------------
  describe('tags', () => {
    it('pulls tags from server and stores in Dexie', async () => {
      const serverTags = [
        { id: 'tag-1', name: 'urgent', userId: 'user-1' },
        { id: 'tag-2', name: 'work', userId: 'user-1' },
      ];

      mockApi.get.mockImplementation((url: string) => {
        if (url === '/tags') return Promise.resolve({ data: serverTags });
        return Promise.resolve({ data: [] });
      });

      mockDb.tags.toArray.mockResolvedValue([]);
      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);

      await syncPull();

      expect(mockDb.tags.bulkPut).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ id: 'tag-1', name: 'urgent', syncStatus: 'synced' }),
          expect.objectContaining({ id: 'tag-2', name: 'work', syncStatus: 'synced' }),
        ]),
      );
    });
  });

  // -----------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------
  describe('error handling', () => {
    it('handles API errors gracefully without crashing', async () => {
      mockApi.get.mockRejectedValue(new Error('Network error'));

      // Should not throw
      await expect(syncPull()).resolves.toBeUndefined();
    });

    it('continues pulling other entities when shared notes fail', async () => {
      mockApi.get.mockImplementation((url: string) => {
        if (url === '/notebooks') return Promise.resolve({ data: [] });
        if (url === '/tags') return Promise.resolve({ data: [] });
        if (url === '/notes?includeTrashed=true') return Promise.resolve({ data: [] });
        if (url === '/share/notes/accepted') return Promise.reject(new Error('403'));
        if (url === '/tasklists') return Promise.resolve({ data: [] });
        if (url === '/share/tasklists/accepted') return Promise.resolve({ data: [] });
        if (url === '/kanban/boards') return Promise.resolve({ data: [] });
        if (url === '/share/kanbans/accepted') return Promise.resolve({ data: [] });
        return Promise.resolve({ data: [] });
      });

      mockDb.notes.toArray.mockResolvedValue([]);
      mockDb.syncQueue.toArray.mockResolvedValue([]);
      mockDb.notes.bulkGet.mockResolvedValue([]);

      // Should not throw
      await expect(syncPull()).resolves.toBeUndefined();

      // Other endpoints were still called
      expect(mockApi.get).toHaveBeenCalledWith('/notebooks');
      expect(mockApi.get).toHaveBeenCalledWith('/tags');
      expect(mockApi.get).toHaveBeenCalledWith('/notes?includeTrashed=true');
    });
  });
});

// ===================================================================
// syncPush
// ===================================================================
describe('syncPush', () => {
  // -----------------------------------------------------------------
  // NOTE entity push
  // -----------------------------------------------------------------
  describe('note push', () => {
    it('pushes CREATE note to API', async () => {
      const queueItem = {
        id: 1, type: 'CREATE' as const, entity: 'NOTE' as const, entityId: 'note-new',
        userId: 'user-1', data: { id: 'note-new', title: 'New Note', notebookId: 'nb-1', content: '<p>Hi</p>' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.notes.get.mockResolvedValue({
        id: 'note-new', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/notes', expect.objectContaining({
        id: 'note-new', title: 'New Note', notebookId: 'nb-1',
      }));
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(1);
    });

    it('pushes UPDATE note to API', async () => {
      const queueItem = {
        id: 2, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-1',
        userId: 'user-1', data: { title: 'Updated Title' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.notes.get.mockResolvedValue({
        id: 'note-1', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      expect(mockApi.put).toHaveBeenCalledWith('/notes/note-1', { title: 'Updated Title' });
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(2);
    });

    it('pushes DELETE note to API', async () => {
      const queueItem = {
        id: 3, type: 'DELETE' as const, entity: 'NOTE' as const, entityId: 'note-del',
        userId: 'user-1', data: {},
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.delete.mockResolvedValue({ data: {} });

      await syncPush();

      expect(mockApi.delete).toHaveBeenCalledWith('/notes/note-del');
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(3);
    });

    it('skips shared notes — removes from queue without API call', async () => {
      const queueItem = {
        id: 4, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'shared-note',
        userId: 'user-1', data: { title: 'Edit' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      // The local note is shared
      mockDb.notes.get.mockResolvedValue({ id: 'shared-note', ownership: 'shared' });

      await syncPush();

      // Should NOT call any API method
      expect(mockApi.post).not.toHaveBeenCalled();
      expect(mockApi.put).not.toHaveBeenCalled();
      expect(mockApi.delete).not.toHaveBeenCalled();
      // Should remove from queue
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(4);
    });
  });

  // -----------------------------------------------------------------
  // NOTEBOOK entity push
  // -----------------------------------------------------------------
  describe('notebook push', () => {
    it('pushes CREATE notebook to API', async () => {
      const queueItem = {
        id: 10, type: 'CREATE' as const, entity: 'NOTEBOOK' as const, entityId: 'nb-new',
        userId: 'user-1', data: { id: 'nb-new', name: 'New Notebook' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.notebooks.get.mockResolvedValue({
        id: 'nb-new', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/notebooks', expect.objectContaining({ name: 'New Notebook' }));
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(10);
    });
  });

  // -----------------------------------------------------------------
  // TAG entity push
  // -----------------------------------------------------------------
  describe('tag push', () => {
    it('pushes CREATE tag to API and updates syncStatus', async () => {
      const queueItem = {
        id: 20, type: 'CREATE' as const, entity: 'TAG' as const, entityId: 'tag-new',
        userId: 'user-1', data: { id: 'tag-new', name: 'important' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/tags', expect.objectContaining({ name: 'important' }));
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(20);
      // Tags have no updatedAt, so syncStatus is updated unconditionally
      expect(mockDb.tags.update).toHaveBeenCalledWith('tag-new', { syncStatus: 'synced' });
    });
  });

  // -----------------------------------------------------------------
  // TASK_LIST entity push
  // -----------------------------------------------------------------
  describe('task list push', () => {
    it('pushes CREATE task list to API', async () => {
      const queueItem = {
        id: 30, type: 'CREATE' as const, entity: 'TASK_LIST' as const, entityId: 'tl-new',
        userId: 'user-1', data: { title: 'New List' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.taskLists.get.mockResolvedValue({
        id: 'tl-new', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/tasklists', expect.objectContaining({
        id: 'tl-new', title: 'New List',
      }));
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(30);
    });
  });

  // -----------------------------------------------------------------
  // TASK_ITEM entity push
  // -----------------------------------------------------------------
  describe('task item push', () => {
    it('pushes CREATE task item with correct URL', async () => {
      const queueItem = {
        id: 31, type: 'CREATE' as const, entity: 'TASK_ITEM' as const, entityId: 'ti-new',
        userId: 'user-1', data: { taskListId: 'tl-1', text: 'New item', isChecked: false },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.taskItems.get.mockResolvedValue({
        id: 'ti-new', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/tasklists/tl-1/items', expect.objectContaining({
        id: 'ti-new', text: 'New item',
      }));
    });
  });

  // -----------------------------------------------------------------
  // KANBAN entity push
  // -----------------------------------------------------------------
  describe('kanban push', () => {
    it('pushes CREATE kanban board to API', async () => {
      const queueItem = {
        id: 40, type: 'CREATE' as const, entity: 'KANBAN_BOARD' as const, entityId: 'kb-new',
        userId: 'user-1', data: { title: 'New Board' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.kanbanBoards.get.mockResolvedValue({ id: 'kb-new', ownership: 'owned', updatedAt: new Date(queueItem.createdAt - 1000).toISOString() });
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/kanban/boards', expect.objectContaining({
        id: 'kb-new', title: 'New Board',
      }));
    });

    it('skips shared kanban boards — removes from queue without API call', async () => {
      const queueItem = {
        id: 41, type: 'UPDATE' as const, entity: 'KANBAN_BOARD' as const, entityId: 'kb-shared',
        userId: 'user-1', data: { title: 'Edit' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockDb.kanbanBoards.get.mockResolvedValue({ id: 'kb-shared', ownership: 'shared' });

      await syncPush();

      expect(mockApi.post).not.toHaveBeenCalled();
      expect(mockApi.put).not.toHaveBeenCalled();
      expect(mockApi.delete).not.toHaveBeenCalled();
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(41);
    });

    it('pushes CREATE kanban column with board-based URL', async () => {
      const queueItem = {
        id: 50, type: 'CREATE' as const, entity: 'KANBAN_COLUMN' as const, entityId: 'col-new',
        userId: 'user-1', data: { boardId: 'kb-1', title: 'In Progress', position: 1 },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/kanban/boards/kb-1/columns', expect.objectContaining({
        id: 'col-new', title: 'In Progress',
      }));
    });

    it('pushes CREATE kanban card with column-based URL', async () => {
      const queueItem = {
        id: 60, type: 'CREATE' as const, entity: 'KANBAN_CARD' as const, entityId: 'card-new',
        userId: 'user-1', data: { columnId: 'col-1', title: 'Fix bug' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.kanbanCards.get.mockResolvedValue({
        id: 'card-new', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      expect(mockApi.post).toHaveBeenCalledWith('/kanban/columns/col-1/cards', expect.objectContaining({
        id: 'card-new', title: 'Fix bug',
      }));
    });
  });

  // -----------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------
  describe('error handling', () => {
    it('handles 404 gracefully — removes item from queue', async () => {
      const queueItem = {
        id: 100, type: 'DELETE' as const, entity: 'NOTE' as const, entityId: 'note-gone',
        userId: 'user-1', data: {},
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.delete.mockRejectedValue({ response: { status: 404 } });

      await syncPush();

      // Item should be removed from queue
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(100);
    });

    it('handles 410 gracefully — removes item from queue', async () => {
      const queueItem = {
        id: 101, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-gone',
        userId: 'user-1', data: { title: 'Update' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockRejectedValue({ response: { status: 410 } });

      await syncPush();

      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(101);
    });

    it('keeps item in queue on other errors (e.g. 500)', async () => {
      const queueItem = {
        id: 102, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-err',
        userId: 'user-1', data: { title: 'Update' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockRejectedValue({ response: { status: 500 } });

      await syncPush();

      // Should NOT delete from queue — will retry on next sync
      expect(mockDb.syncQueue.delete).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // Concurrency guard
  // -----------------------------------------------------------------
  describe('concurrency guard', () => {
    it('guards against concurrent sync — only one runs at a time', async () => {
      let resolveFirst!: () => void;
      const firstCallPromise = new Promise<void>(resolve => { resolveFirst = resolve; });

      const queueItem = {
        id: 200, type: 'CREATE' as const, entity: 'NOTE' as const, entityId: 'note-slow',
        userId: 'user-1', data: { id: 'note-slow', title: 'Slow' },
        createdAt: Date.now(),
      };

      let postCallCount = 0;
      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.post.mockImplementation(() => {
        postCallCount++;
        if (postCallCount === 1) {
          return firstCallPromise.then(() => ({ data: {} }));
        }
        return Promise.resolve({ data: {} });
      });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.notes.get.mockResolvedValue({
        id: 'note-slow', updatedAt: new Date(queueItem.createdAt - 1000).toISOString(),
      });

      // Start first sync (will hang on api.post)
      const first = syncPush();

      // Start second sync immediately — should return early due to isSyncing guard
      const second = syncPush();
      await second; // second resolves immediately

      // Resolve the first call
      resolveFirst();
      await first;

      // API should have been called only ONCE
      expect(postCallCount).toBe(1);
    });
  });

  // -----------------------------------------------------------------
  // syncStatus update after push
  // -----------------------------------------------------------------
  describe('syncStatus update', () => {
    it('updates syncStatus to "synced" after successful push when no pending items', async () => {
      const now = Date.now();
      const queueItem = {
        id: 300, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-1',
        userId: 'user-1', data: { title: 'Updated' },
        createdAt: now,
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      // Note was last updated BEFORE the queue item was created
      mockDb.notes.get.mockResolvedValue({
        id: 'note-1', updatedAt: new Date(now - 5000).toISOString(),
      });

      await syncPush();

      expect(mockDb.notes.update).toHaveBeenCalledWith('note-1', { syncStatus: 'synced' });
    });

    it('does NOT update syncStatus if note was modified after queue item creation (race condition)', async () => {
      const now = Date.now();
      const queueItem = {
        id: 301, type: 'UPDATE' as const, entity: 'NOTE' as const, entityId: 'note-1',
        userId: 'user-1', data: { title: 'Updated' },
        createdAt: now - 5000, // queue item created 5 seconds ago
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.put.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      // Note was updated AFTER the queue item — user typed more
      mockDb.notes.get.mockResolvedValue({
        id: 'note-1', updatedAt: new Date(now).toISOString(),
      });

      await syncPush();

      // Queue item removed (push succeeded)
      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(301);
      // But notes.update should NOT be called (race condition protection)
      expect(mockDb.notes.update).not.toHaveBeenCalled();
    });

    it('does NOT update syncStatus for DELETE operations', async () => {
      const queueItem = {
        id: 302, type: 'DELETE' as const, entity: 'NOTE' as const, entityId: 'note-del',
        userId: 'user-1', data: {},
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([queueItem]);
      mockApi.delete.mockResolvedValue({ data: {} });

      await syncPush();

      expect(mockDb.syncQueue.delete).toHaveBeenCalledWith(302);
      // Should NOT attempt to update syncStatus (entity was deleted)
      expect(mockDb.notes.update).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------
  // User isolation
  // -----------------------------------------------------------------
  describe('user isolation', () => {
    it('only processes queue items belonging to current user', async () => {
      const myItem = {
        id: 400, type: 'CREATE' as const, entity: 'NOTE' as const, entityId: 'note-mine',
        userId: 'user-1', data: { id: 'note-mine', title: 'Mine' },
        createdAt: Date.now(),
      };
      const otherItem = {
        id: 401, type: 'CREATE' as const, entity: 'NOTE' as const, entityId: 'note-other',
        userId: 'user-2', data: { id: 'note-other', title: 'Other' },
        createdAt: Date.now(),
      };

      mockDb.syncQueue.toArray.mockResolvedValue([myItem, otherItem]);
      mockApi.post.mockResolvedValue({ data: {} });
      mockDb.syncQueue.count.mockResolvedValue(0);
      mockDb.notes.get.mockResolvedValue({
        id: 'note-mine', updatedAt: new Date(myItem.createdAt - 1000).toISOString(),
      });

      await syncPush();

      // Only my item should have been pushed
      expect(mockApi.post).toHaveBeenCalledTimes(1);
      expect(mockApi.post).toHaveBeenCalledWith('/notes', expect.objectContaining({ title: 'Mine' }));
    });

    it('does nothing if no user is logged in', async () => {
      mockAuthStore.getState.mockReturnValue({ user: null as unknown as { id: string } });

      mockDb.syncQueue.toArray.mockResolvedValue([
        { id: 500, type: 'CREATE', entity: 'NOTE', entityId: 'x', userId: 'user-1', data: {}, createdAt: Date.now() },
      ]);

      await syncPush();

      // Should bail out immediately
      expect(mockApi.post).not.toHaveBeenCalled();
      expect(mockApi.put).not.toHaveBeenCalled();
      expect(mockApi.delete).not.toHaveBeenCalled();
    });
  });
});
