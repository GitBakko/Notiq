import { Prisma } from '@prisma/client';
import prisma from '../plugins/prisma';
import logger from '../utils/logger';

export const logEvent = async (userId: string, event: string, details?: Prisma.InputJsonValue) => {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        event,
        details,
      },
    });
  } catch (error) {
    logger.error(error, 'Failed to create audit log');
    // Don't throw, audit logging failure shouldn't block main flow
  }
};

export interface AuditLogFilters {
  event?: string;
  userId?: string;
  dateFrom?: string; // ISO date
  dateTo?: string;   // ISO date
}

export async function getAuditLogFiltered(
  page = 1,
  limit = 20,
  filters: AuditLogFilters = {}
) {
  const skip = (page - 1) * limit;
  const where: Prisma.AuditLogWhereInput = {};

  if (filters.event) {
    where.event = filters.event;
  }
  if (filters.userId) {
    where.userId = filters.userId;
  }
  if (filters.dateFrom || filters.dateTo) {
    where.createdAt = {};
    if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo);
  }

  const [logs, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { email: true, name: true } } },
    }),
    prisma.auditLog.count({ where }),
  ]);

  return { logs, total, pages: Math.ceil(total / limit) };
}

export async function getAuditStats(days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  // Event distribution
  const eventCounts: { event: string; count: bigint }[] = await prisma.$queryRaw`
    SELECT event, COUNT(*)::bigint as count
    FROM "AuditLog"
    WHERE "createdAt" >= ${since}
    GROUP BY event
    ORDER BY count DESC
  `;

  // Daily timeline
  const dailyTimeline: { day: Date; count: bigint }[] = await prisma.$queryRaw`
    SELECT date_trunc('day', "createdAt") as day, COUNT(*)::bigint as count
    FROM "AuditLog"
    WHERE "createdAt" >= ${since}
    GROUP BY day
    ORDER BY day ASC
  `;

  // Distinct event types (for filter dropdown)
  const eventTypes: { event: string }[] = await prisma.$queryRaw`
    SELECT DISTINCT event FROM "AuditLog" ORDER BY event ASC
  `;

  return {
    eventCounts: eventCounts.map(r => ({ event: r.event, count: Number(r.count) })),
    dailyTimeline: dailyTimeline.map(r => ({
      date: r.day.toISOString().substring(0, 10),
      count: Number(r.count),
    })),
    eventTypes: eventTypes.map(r => r.event),
  };
}
