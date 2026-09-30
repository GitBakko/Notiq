import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../plugins/prisma', () => {
  const m = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  return {
    default: {
      friendship: m(), sharedNote: m(), sharedNotebook: m(), sharedTaskList: m(), sharedKanbanBoard: m(), groupMember: m(),
    },
  };
});

import prisma from '../../plugins/prisma';
import { getAutoFriendCandidates } from '../friendship.service';

const prismaMock = prisma as any;

describe('getAutoFriendCandidates', () => {
  beforeEach(() => vi.clearAllMocks());

  it('derives suggestions only from non-vault note shares', async () => {
    await getAutoFriendCandidates('u1');

    const where = prismaMock.sharedNote.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('ACCEPTED');
    expect(where.note).toEqual({ isVault: false });
    expect(where.OR).toEqual([{ userId: 'u1' }, { note: { userId: 'u1' } }]);
  });
});
