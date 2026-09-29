import prisma from '../plugins/prisma';

const THROTTLE_MS = 5 * 60 * 1000;
const lastActiveCache = new Map<string, number>();

// Fire-and-forget: a failed touch must never fail the request it rides on.
export function touchLastActive(
  userId: string,
  log: { warn: (obj: object, msg: string) => void },
  now: number = Date.now(),
): void {
  const last = lastActiveCache.get(userId) || 0;
  if (now - last <= THROTTLE_MS) return;
  lastActiveCache.set(userId, now);
  prisma.user
    .update({ where: { id: userId }, data: { lastActiveAt: new Date(now) } })
    .catch((err) => log.warn({ err, userId }, 'lastActiveAt update failed'));
}

// Test-only: the cache is module state and would leak between tests.
export function __resetLastActiveCache(): void {
  lastActiveCache.clear();
}
