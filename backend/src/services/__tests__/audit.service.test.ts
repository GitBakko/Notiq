import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';
import logger from '../../utils/logger';
import { logEvent } from '../audit.service';

const prismaMock = prisma as any;
const loggerMock = logger as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// logEvent
// ---------------------------------------------------------------------------
describe('logEvent', () => {
  it('creates an audit log entry with userId, event, and details', async () => {
    prismaMock.auditLog.create.mockResolvedValue({
      id: 'log-1',
      userId: 'user-1',
      event: 'LOGIN',
      details: { ip: '127.0.0.1' },
    });

    await logEvent('user-1', 'LOGIN', { ip: '127.0.0.1' });

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        event: 'LOGIN',
        details: { ip: '127.0.0.1' },
      },
    });
  });

  it('creates an audit log entry without details when not provided', async () => {
    prismaMock.auditLog.create.mockResolvedValue({
      id: 'log-2',
      userId: 'user-1',
      event: 'LOGOUT',
      details: undefined,
    });

    await logEvent('user-1', 'LOGOUT');

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        event: 'LOGOUT',
        details: undefined,
      },
    });
  });

  it('does not throw when prisma.auditLog.create fails', async () => {
    prismaMock.auditLog.create.mockRejectedValue(new Error('DB connection lost'));

    // Should not throw — audit failures are swallowed
    await expect(logEvent('user-1', 'LOGIN')).resolves.toBeUndefined();
  });

  it('logs the error when prisma.auditLog.create fails', async () => {
    const dbError = new Error('DB connection lost');
    prismaMock.auditLog.create.mockRejectedValue(dbError);

    await logEvent('user-1', 'LOGIN');

    expect(loggerMock.error).toHaveBeenCalledWith(dbError, 'Failed to create audit log');
  });

  it('accepts complex JSON details', async () => {
    const complexDetails = {
      action: 'NOTE_CREATED',
      noteId: 'note-1',
      metadata: { tags: ['work', 'important'], size: 1024 },
    };
    prismaMock.auditLog.create.mockResolvedValue({
      id: 'log-3',
      userId: 'user-1',
      event: 'NOTE_CREATED',
      details: complexDetails,
    });

    await logEvent('user-1', 'NOTE_CREATED', complexDetails);

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        event: 'NOTE_CREATED',
        details: complexDetails,
      },
    });
  });

  it('accepts null as details value', async () => {
    prismaMock.auditLog.create.mockResolvedValue({
      id: 'log-4',
      userId: 'user-1',
      event: 'SETTINGS_CHANGE',
      details: null,
    });

    await logEvent('user-1', 'SETTINGS_CHANGE', null as any);

    expect(prismaMock.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        event: 'SETTINGS_CHANGE',
        details: null,
      },
    });
  });
});
