import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';

import {
  getDashboardStats,
  getUsers,
  getAuditLogs,
  updateUser,
} from '../admin.service';

const prismaMock = prisma as any;

// ---------------------------------------------------------------------------
// Add mock methods not present in global setup.ts
// ---------------------------------------------------------------------------

prismaMock.auditLog.count = vi.fn();
prismaMock.note.groupBy = vi.fn();
prismaMock.notebook.count = vi.fn();
prismaMock.tag.count = vi.fn();
prismaMock.sharedNote.count = vi.fn();
prismaMock.sharedNotebook.count = vi.fn();

// ---------------------------------------------------------------------------
// Reset all mocks before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// getDashboardStats
// ---------------------------------------------------------------------------
describe('getDashboardStats', () => {
  function setupDefaultMocks(): void {
    prismaMock.user.count
      .mockResolvedValueOnce(10)   // totalUsers
      .mockResolvedValueOnce(5);   // activeUsers

    prismaMock.note.count.mockResolvedValue(50);
    prismaMock.notebook.count.mockResolvedValue(8);

    prismaMock.attachment.aggregate.mockResolvedValue({
      _sum: { size: 1024000 },
      _count: { id: 25 },
    });

    prismaMock.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'user1@test.com', name: 'User 1', createdAt: new Date('2026-01-15'), role: 'USER' },
      { id: 'u2', email: 'user2@test.com', name: 'User 2', createdAt: new Date('2026-01-10'), role: 'SUPERADMIN' },
    ]);

    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ month: new Date('2026-01-01'), count: 3n }])  // registrationHistory
      .mockResolvedValueOnce([{ month: new Date('2026-01-01'), count: 12n }]) // notesHistory
      .mockResolvedValueOnce([{ category: 'Images', total_size: 500000n, count: 10n }]) // storageByType
      .mockResolvedValueOnce([{ month: new Date('2026-02-01'), count: 7n }]); // sharingHistory

    prismaMock.tag.count.mockResolvedValue(20);
    prismaMock.sharedNote.count.mockResolvedValue(15);
    prismaMock.sharedNotebook.count.mockResolvedValue(3);
    prismaMock.note.groupBy.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);
  }

  it('returns all KPIs with correct values', async () => {
    setupDefaultMocks();

    const result = await getDashboardStats();

    expect(result.kpi.totalUsers).toBe(10);
    expect(result.kpi.activeUsers).toBe(5);
    expect(result.kpi.totalNotes).toBe(50);
    expect(result.kpi.totalNotebooks).toBe(8);
    expect(result.kpi.totalStorageBytes).toBe(1024000);
    expect(result.kpi.totalAttachments).toBe(25);
    expect(result.kpi.avgNotesPerUser).toBe(5.0);
    expect(result.kpi.totalTags).toBe(20);
    expect(result.kpi.totalSharedNotes).toBe(15);
    expect(result.kpi.totalSharedNotebooks).toBe(3);
    expect(result.kpi.vaultUsersCount).toBe(2);
  });

  it('computes avgNotesPerUser as 0 when there are no users', async () => {
    prismaMock.user.count
      .mockResolvedValueOnce(0)   // totalUsers = 0
      .mockResolvedValueOnce(0);  // activeUsers

    prismaMock.note.count.mockResolvedValue(0);
    prismaMock.notebook.count.mockResolvedValue(0);

    prismaMock.attachment.aggregate.mockResolvedValue({
      _sum: { size: null },
      _count: { id: 0 },
    });

    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])  // registrationHistory
      .mockResolvedValueOnce([])  // notesHistory
      .mockResolvedValueOnce([])  // storageByType
      .mockResolvedValueOnce([]); // sharingHistory

    prismaMock.tag.count.mockResolvedValue(0);
    prismaMock.sharedNote.count.mockResolvedValue(0);
    prismaMock.sharedNotebook.count.mockResolvedValue(0);
    prismaMock.note.groupBy.mockResolvedValue([]);

    const result = await getDashboardStats();

    expect(result.kpi.avgNotesPerUser).toBe(0);
    expect(result.kpi.totalStorageBytes).toBe(0);
    expect(result.kpi.totalAttachments).toBe(0);
    expect(result.kpi.vaultUsersCount).toBe(0);
  });

  it('defaults totalStorageBytes to 0 when aggregate sum is null', async () => {
    prismaMock.user.count
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);

    prismaMock.note.count.mockResolvedValue(5);
    prismaMock.notebook.count.mockResolvedValue(1);

    prismaMock.attachment.aggregate.mockResolvedValue({
      _sum: { size: null },
      _count: { id: 0 },
    });

    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    prismaMock.tag.count.mockResolvedValue(0);
    prismaMock.sharedNote.count.mockResolvedValue(0);
    prismaMock.sharedNotebook.count.mockResolvedValue(0);
    prismaMock.note.groupBy.mockResolvedValue([]);

    const result = await getDashboardStats();

    expect(result.kpi.totalStorageBytes).toBe(0);
    expect(result.kpi.totalAttachments).toBe(0);
  });

  it('formats chart registration history as YYYY-MM strings', async () => {
    setupDefaultMocks();

    const result = await getDashboardStats();

    expect(result.charts.registrationHistory).toEqual([
      { date: '2026-01', count: 3 },
    ]);
  });

  it('formats chart notes history correctly', async () => {
    setupDefaultMocks();

    const result = await getDashboardStats();

    expect(result.charts.notesHistory).toEqual([
      { date: '2026-01', count: 12 },
    ]);
  });

  it('formats chart sharing history correctly', async () => {
    setupDefaultMocks();

    const result = await getDashboardStats();

    expect(result.charts.sharingHistory).toEqual([
      { date: '2026-02', count: 7 },
    ]);
  });

  it('maps storageByType from raw SQL and filters out zero values', async () => {
    setupDefaultMocks();

    const result = await getDashboardStats();

    expect(result.charts.storageByType).toEqual([
      { name: 'Images', value: 500000 },
    ]);
  });

  it('filters out storageByType entries with zero total_size', async () => {
    prismaMock.user.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);

    prismaMock.note.count.mockResolvedValue(1);
    prismaMock.notebook.count.mockResolvedValue(1);
    prismaMock.attachment.aggregate.mockResolvedValue({ _sum: { size: 100 }, _count: { id: 1 } });
    prismaMock.user.findMany.mockResolvedValue([]);

    prismaMock.$queryRaw
      .mockResolvedValueOnce([])  // registrationHistory
      .mockResolvedValueOnce([])  // notesHistory
      .mockResolvedValueOnce([    // storageByType — includes zero entry
        { category: 'Images', total_size: 500n, count: 2n },
        { category: 'Documents', total_size: 0n, count: 0n },
      ])
      .mockResolvedValueOnce([]); // sharingHistory

    prismaMock.tag.count.mockResolvedValue(0);
    prismaMock.sharedNote.count.mockResolvedValue(0);
    prismaMock.sharedNotebook.count.mockResolvedValue(0);
    prismaMock.note.groupBy.mockResolvedValue([]);

    const result = await getDashboardStats();

    expect(result.charts.storageByType).toEqual([
      { name: 'Images', value: 500 },
    ]);
  });

  it('returns recent users ordered by createdAt desc', async () => {
    setupDefaultMocks();

    const result = await getDashboardStats();

    expect(result.recentUsers).toHaveLength(2);
    expect(result.recentUsers[0].id).toBe('u1');
    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      take: 5,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        createdAt: true,
        role: true,
      },
    });
  });

  it('rounds avgNotesPerUser to one decimal place', async () => {
    prismaMock.user.count
      .mockResolvedValueOnce(3)   // totalUsers
      .mockResolvedValueOnce(2);  // activeUsers

    prismaMock.note.count.mockResolvedValue(10); // 10 / 3 = 3.333...
    prismaMock.notebook.count.mockResolvedValue(1);
    prismaMock.attachment.aggregate.mockResolvedValue({ _sum: { size: 0 }, _count: { id: 0 } });
    prismaMock.user.findMany.mockResolvedValue([]);

    prismaMock.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    prismaMock.tag.count.mockResolvedValue(0);
    prismaMock.sharedNote.count.mockResolvedValue(0);
    prismaMock.sharedNotebook.count.mockResolvedValue(0);
    prismaMock.note.groupBy.mockResolvedValue([]);

    const result = await getDashboardStats();

    expect(result.kpi.avgNotesPerUser).toBe(3.3);
  });

  it('handles multiple months in chart histories', async () => {
    prismaMock.user.count
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(3);

    prismaMock.note.count.mockResolvedValue(20);
    prismaMock.notebook.count.mockResolvedValue(4);
    prismaMock.attachment.aggregate.mockResolvedValue({ _sum: { size: 0 }, _count: { id: 0 } });
    prismaMock.user.findMany.mockResolvedValue([]);

    prismaMock.$queryRaw
      .mockResolvedValueOnce([
        { month: new Date('2025-10-01'), count: 2n },
        { month: new Date('2025-11-01'), count: 1n },
        { month: new Date('2025-12-01'), count: 2n },
      ])
      .mockResolvedValueOnce([
        { month: new Date('2025-12-01'), count: 8n },
        { month: new Date('2026-01-01'), count: 12n },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { month: new Date('2026-01-01'), count: 3n },
      ]);

    prismaMock.tag.count.mockResolvedValue(0);
    prismaMock.sharedNote.count.mockResolvedValue(0);
    prismaMock.sharedNotebook.count.mockResolvedValue(0);
    prismaMock.note.groupBy.mockResolvedValue([]);

    const result = await getDashboardStats();

    expect(result.charts.registrationHistory).toEqual([
      { date: '2025-10', count: 2 },
      { date: '2025-11', count: 1 },
      { date: '2025-12', count: 2 },
    ]);
    expect(result.charts.notesHistory).toEqual([
      { date: '2025-12', count: 8 },
      { date: '2026-01', count: 12 },
    ]);
    expect(result.charts.sharingHistory).toEqual([
      { date: '2026-01', count: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// getUsers
// ---------------------------------------------------------------------------
describe('getUsers', () => {
  const userListItem = {
    id: 'u1',
    email: 'user1@test.com',
    name: 'User 1',
    role: 'USER',
    isVerified: true,
    lastActiveAt: new Date(),
    createdAt: new Date(),
    _count: { notes: 5 },
  };

  it('returns paginated users with defaults (page=1, limit=10, no search)', async () => {
    prismaMock.user.findMany.mockResolvedValue([userListItem]);
    prismaMock.user.count.mockResolvedValue(1);

    const result = await getUsers();

    expect(result).toEqual({ users: [userListItem], total: 1, pages: 1 });
    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 10,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isVerified: true,
        lastActiveAt: true,
        createdAt: true,
        _count: { select: { notes: true } },
      },
    });
    expect(prismaMock.user.count).toHaveBeenCalledWith({ where: {} });
  });

  it('calculates skip correctly for page 3 with limit 5', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.count.mockResolvedValue(12);

    const result = await getUsers(3, 5);

    expect(result).toEqual({ users: [], total: 12, pages: 3 });
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 10, take: 5 }),
    );
  });

  it('applies search filter on email and name (case-insensitive)', async () => {
    prismaMock.user.findMany.mockResolvedValue([userListItem]);
    prismaMock.user.count.mockResolvedValue(1);

    const result = await getUsers(1, 10, 'user1');

    expect(result.users).toEqual([userListItem]);
    const expectedWhere = {
      OR: [
        { email: { contains: 'user1', mode: 'insensitive' } },
        { name: { contains: 'user1', mode: 'insensitive' } },
      ],
    };
    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedWhere }),
    );
    expect(prismaMock.user.count).toHaveBeenCalledWith({ where: expectedWhere });
  });

  it('computes total pages correctly (ceiling division)', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.count.mockResolvedValue(23);

    const result = await getUsers(1, 10);

    expect(result.pages).toBe(3); // Math.ceil(23 / 10) = 3
  });

  it('returns pages=0 when there are no users', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.count.mockResolvedValue(0);

    const result = await getUsers();

    expect(result).toEqual({ users: [], total: 0, pages: 0 });
  });

  it('uses empty where clause when search is empty string', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.count.mockResolvedValue(0);

    await getUsers(1, 10, '');

    expect(prismaMock.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

// ---------------------------------------------------------------------------
// getAuditLogs
// ---------------------------------------------------------------------------
describe('getAuditLogs', () => {
  const logEntry = {
    id: 'log-1',
    action: 'LOGIN',
    userId: 'u1',
    details: null,
    createdAt: new Date(),
    user: { email: 'user1@test.com' },
  };

  it('returns paginated audit logs with defaults (page=1, limit=20)', async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([logEntry]);
    prismaMock.auditLog.count.mockResolvedValue(1);

    const result = await getAuditLogs();

    expect(result).toEqual({ logs: [logEntry], total: 1, pages: 1 });
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith({
      skip: 0,
      take: 20,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true } } },
    });
    expect(prismaMock.auditLog.count).toHaveBeenCalled();
  });

  it('calculates skip correctly for page 2 with limit 5', async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.count.mockResolvedValue(8);

    const result = await getAuditLogs(2, 5);

    expect(result).toEqual({ logs: [], total: 8, pages: 2 });
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 }),
    );
  });

  it('computes total pages correctly (ceiling division)', async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.count.mockResolvedValue(45);

    const result = await getAuditLogs(1, 20);

    expect(result.pages).toBe(3); // Math.ceil(45 / 20) = 3
  });

  it('returns pages=0 when there are no logs', async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);
    prismaMock.auditLog.count.mockResolvedValue(0);

    const result = await getAuditLogs();

    expect(result).toEqual({ logs: [], total: 0, pages: 0 });
  });

  it('includes user email in the log entries', async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([logEntry]);
    prismaMock.auditLog.count.mockResolvedValue(1);

    const result = await getAuditLogs();

    expect(result.logs[0].user.email).toBe('user1@test.com');
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: { user: { select: { email: true } } },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// updateUser
// ---------------------------------------------------------------------------
describe('updateUser', () => {
  it('updates user role', async () => {
    const updated = { id: 'u1', email: 'user@test.com', role: 'SUPERADMIN' };
    prismaMock.user.update.mockResolvedValue(updated);

    const result = await updateUser('u1', { role: 'SUPERADMIN' });

    expect(result).toEqual(updated);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: 'SUPERADMIN' },
    });
  });

  it('updates user isVerified flag', async () => {
    const updated = { id: 'u1', email: 'user@test.com', isVerified: true };
    prismaMock.user.update.mockResolvedValue(updated);

    const result = await updateUser('u1', { isVerified: true });

    expect(result).toEqual(updated);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isVerified: true },
    });
  });

  it('updates both role and isVerified at once', async () => {
    const updated = { id: 'u1', role: 'USER', isVerified: false };
    prismaMock.user.update.mockResolvedValue(updated);

    const result = await updateUser('u1', { role: 'USER', isVerified: false });

    expect(result).toEqual(updated);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { role: 'USER', isVerified: false },
    });
  });

  it('propagates Prisma errors when user is not found', async () => {
    const prismaError = new Error('Record to update not found.');
    (prismaError as any).code = 'P2025';
    prismaMock.user.update.mockRejectedValue(prismaError);

    await expect(updateUser('nonexistent', { role: 'USER' })).rejects.toThrow(
      'Record to update not found.',
    );
  });

  it('passes empty data object through to Prisma', async () => {
    const updated = { id: 'u1', email: 'user@test.com', role: 'USER' };
    prismaMock.user.update.mockResolvedValue(updated);

    const result = await updateUser('u1', {});

    expect(result).toEqual(updated);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: {},
    });
  });
});
