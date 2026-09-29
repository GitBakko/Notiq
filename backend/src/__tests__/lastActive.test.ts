import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../plugins/prisma';
import { touchLastActive, __resetLastActiveCache } from '../utils/lastActive';

// D1 — lastActiveAt was written by a global onRequest hook that ran before
// fastify.authenticate, so request.user was always undefined and nothing was
// ever written. The logic now lives in utils/lastActive and is called from the
// authenticate decorator; these tests pin its throttle and its failure mode.
const prismaMock = prisma as any;

const THROTTLE_MS = 5 * 60 * 1000;
const NOW = 1_000_000;

let log: { warn: ReturnType<typeof vi.fn> };

beforeEach(() => {
  __resetLastActiveCache();
  prismaMock.user.update = vi.fn().mockResolvedValue({});
  log = { warn: vi.fn() };
});

describe('touchLastActive', () => {
  it('writes lastActiveAt on the first touch', () => {
    touchLastActive('u1', log, NOW);

    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { lastActiveAt: new Date(NOW) },
    });
  });

  it('throttles touches inside the 5-minute window', () => {
    touchLastActive('u1', log, NOW);
    touchLastActive('u1', log, NOW + 60_000);
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);

    touchLastActive('u1', log, NOW + THROTTLE_MS);
    expect(prismaMock.user.update).toHaveBeenCalledTimes(1);

    touchLastActive('u1', log, NOW + THROTTLE_MS + 1);
    expect(prismaMock.user.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.user.update).toHaveBeenLastCalledWith({
      where: { id: 'u1' },
      data: { lastActiveAt: new Date(NOW + THROTTLE_MS + 1) },
    });
  });

  it('does not throttle distinct users against each other', () => {
    touchLastActive('u1', log, NOW);
    touchLastActive('u2', log, NOW + 1);

    expect(prismaMock.user.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.user.update.mock.calls[1][0].where).toEqual({ id: 'u2' });
  });

  it('never propagates a database failure, and logs it', async () => {
    prismaMock.user.update = vi.fn().mockRejectedValueOnce(new Error('db down'));

    expect(() => touchLastActive('u1', log, NOW)).not.toThrow();
    await new Promise((r) => setImmediate(r));

    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      'lastActiveAt update failed',
    );
  });
});
