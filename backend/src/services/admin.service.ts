import prisma from '../plugins/prisma';

export interface DashboardStats {
  kpi: {
    totalUsers: number;
    activeUsers: number; // Last 30 days
    totalNotes: number;
    totalNotebooks: number;
    totalStorageBytes: number;
    totalAttachments: number;
    avgNotesPerUser: number;
    totalTags: number;
    totalSharedNotes: number;
    totalSharedNotebooks: number;
    vaultUsersCount: number;
  };
  charts: {
    registrationHistory: { date: string; count: number }[];
    notesHistory: { date: string; count: number }[];
    storageByType: { name: string; value: number }[];
    sharingHistory: { date: string; count: number }[];
  };
  recentUsers: {
    id: string;
    email: string;
    name: string | null;
    createdAt: Date;
    role: string;
  }[];
}

export async function getDashboardStats(): Promise<DashboardStats> {
  // KPIs
  const totalUsers = await prisma.user.count();

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const activeUsers = await prisma.user.count({
    where: {
      lastActiveAt: {
        gte: thirtyDaysAgo,
      },
    },
  });

  const totalNotes = await prisma.note.count();
  const totalNotebooks = await prisma.notebook.count();

  const storageAgg = await prisma.attachment.aggregate({
    _sum: {
      size: true,
    },
    _count: {
      id: true,
    },
  });

  const totalStorageBytes = storageAgg._sum.size || 0;
  const totalAttachments = storageAgg._count.id || 0;
  const avgNotesPerUser = totalUsers > 0 ? parseFloat((totalNotes / totalUsers).toFixed(1)) : 0;

  // Recent Users
  const recentUsers = await prisma.user.findMany({
    take: 5,
    orderBy: {
      createdAt: 'desc',
    },
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      role: true,
    },
  });

  // Charts: Registration History (Last 6 months)
  // Using raw query for easier date grouping in Postgres
  // Falls back to simple fetching if not postgres, but project uses postgres.
  const registrationHistory: { month: Date; count: bigint }[] = await prisma.$queryRaw`
    SELECT date_trunc('month', "createdAt") as month, count(*)::int as count 
    FROM "User" 
    WHERE "createdAt" >= NOW() - INTERVAL '6 months'
    GROUP BY month 
    ORDER BY month ASC
  `;

  // Charts: Notes History
  const notesHistory: { month: Date; count: bigint }[] = await prisma.$queryRaw`
    SELECT date_trunc('month', "createdAt") as month, count(*)::int as count 
    FROM "Note" 
    WHERE "createdAt" >= NOW() - INTERVAL '6 months'
    GROUP BY month 
    ORDER BY month ASC
  `;

  // Storage Breakdown by MimeType category — use SQL aggregate instead of loading all rows
  const storageByTypeRaw: { category: string; total_size: bigint; count: bigint }[] = await prisma.$queryRaw`
    SELECT
      CASE
        WHEN "mimeType" LIKE 'image/%' THEN 'Images'
        WHEN "mimeType" LIKE 'text/%' OR "mimeType" LIKE '%pdf%' OR "mimeType" LIKE '%document%' THEN 'Documents'
        WHEN "mimeType" LIKE '%zip%' OR "mimeType" LIKE '%compressed%' THEN 'Archives'
        WHEN "mimeType" LIKE 'audio/%' OR "mimeType" LIKE 'video/%' THEN 'AudioVideo'
        ELSE 'Other'
      END as category,
      COALESCE(SUM(size), 0)::bigint as total_size,
      COUNT(*)::bigint as count
    FROM "Attachment"
    GROUP BY category
  `;

  const storageByType = storageByTypeRaw
    .map(r => ({ name: r.category, value: Number(r.total_size) }))
    .filter(x => x.value > 0);

  // Extended Metrics
  const totalTags = await prisma.tag.count();
  const totalSharedNotes = await prisma.sharedNote.count();
  const totalSharedNotebooks = await prisma.sharedNotebook.count();

  // Vault Metrics: Count distinct users who have at least one vault note
  // Using groupBy because count distinct might be tricky with standard prismaclient api in some versions
  const vaultUsersAgg = await prisma.note.groupBy({
    by: ['userId'],
    where: { isVault: true },
  });
  const vaultUsersCount = vaultUsersAgg.length;

  // Chart: Sharing History (Last 6 months)
  const sharingHistory: { month: Date; count: bigint }[] = await prisma.$queryRaw`
    SELECT date_trunc('month', "createdAt") as month, count(*)::int as count 
    FROM "SharedNote" 
    WHERE "createdAt" >= NOW() - INTERVAL '6 months'
    GROUP BY month 
    ORDER BY month ASC
  `;

  return {
    kpi: {
      totalUsers,
      activeUsers,
      totalNotes,
      totalNotebooks,
      totalStorageBytes,
      totalAttachments,
      avgNotesPerUser,
      // New KPIs
      totalTags,
      totalSharedNotes,
      totalSharedNotebooks,
      vaultUsersCount
    },
    charts: {
      registrationHistory: registrationHistory.map(r => ({
        date: r.month.toISOString().substring(0, 7),
        count: Number(r.count),
      })),
      notesHistory: notesHistory.map(r => ({
        date: r.month.toISOString().substring(0, 7),
        count: Number(r.count),
      })),
      sharingHistory: sharingHistory.map(r => ({
        date: r.month.toISOString().substring(0, 7),
        count: Number(r.count),
      })),
      storageByType
    },
    recentUsers,
  };
}

export async function getUsers(page = 1, limit = 10, search = '') {
  const skip = (page - 1) * limit;
  const where = search ? {
    OR: [
      { email: { contains: search, mode: 'insensitive' as const } },
      { name: { contains: search, mode: 'insensitive' as const } }
    ]
  } : {};

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, email: true, name: true, role: true, isVerified: true, lastActiveAt: true, createdAt: true,
        _count: { select: { notes: true } }
      }
    }),
    prisma.user.count({ where })
  ]);

  return { users, total, pages: Math.ceil(total / limit) };
}

export async function getAuditLogs(page = 1, limit = 20) {
  // Legacy wrapper — delegates to audit.service for backward compat
  const { getAuditLogFiltered } = await import('./audit.service');
  return getAuditLogFiltered(page, limit);
}

export async function updateUser(userId: string, data: { role?: 'USER' | 'SUPERADMIN'; isVerified?: boolean; }) {
  return prisma.user.update({
    where: { id: userId },
    data
  });
}

export async function deleteUser(userId: string) {
  // Delete all related data in correct order (respecting FK constraints)
  await prisma.$transaction(async (tx) => {
    // Delete kanban-related data (cascade covers reminders, activities, comments from cards/boards)
    await tx.kanbanReminder.deleteMany({ where: { userId } });
    await tx.kanbanCardActivity.deleteMany({ where: { userId } });
    await tx.kanbanComment.deleteMany({ where: { authorId: userId } });
    await tx.kanbanBoardChat.deleteMany({ where: { authorId: userId } });
    // Delete cards owned by user's boards (via columns)
    const userBoards = await tx.kanbanBoard.findMany({ where: { ownerId: userId }, select: { id: true } });
    const boardIds = userBoards.map(b => b.id);
    if (boardIds.length > 0) {
      const userColumns = await tx.kanbanColumn.findMany({ where: { boardId: { in: boardIds } }, select: { id: true } });
      const columnIds = userColumns.map(c => c.id);
      if (columnIds.length > 0) {
        await tx.kanbanCard.deleteMany({ where: { columnId: { in: columnIds } } });
      }
      await tx.kanbanColumn.deleteMany({ where: { boardId: { in: boardIds } } });
    }
    await tx.sharedKanbanBoard.deleteMany({ where: { OR: [{ boardId: { in: boardIds } }, { userId }] } });
    await tx.kanbanBoard.deleteMany({ where: { ownerId: userId } });

    // Delete task-related data
    await tx.taskItem.deleteMany({ where: { taskList: { userId } } });
    await tx.sharedTaskList.deleteMany({ where: { OR: [{ taskList: { userId } }, { userId }] } });
    await tx.taskList.deleteMany({ where: { userId } });

    // Delete sharing data
    await tx.sharedNote.deleteMany({ where: { OR: [{ note: { userId } }, { userId }] } });
    await tx.sharedNotebook.deleteMany({ where: { OR: [{ notebook: { userId } }, { userId }] } });

    // Delete notes and related
    await tx.tagsOnNotes.deleteMany({ where: { note: { userId } } });
    await tx.attachment.deleteMany({ where: { note: { userId } } });
    await tx.chatMessage.deleteMany({ where: { userId } });
    await tx.note.deleteMany({ where: { userId } });

    // Delete notebooks
    await tx.notebook.deleteMany({ where: { userId } });

    // Delete tags
    await tx.tag.deleteMany({ where: { userId } });

    // Delete groups
    await tx.pendingGroupInvite.deleteMany({ where: { invitedBy: userId } });
    await tx.groupMember.deleteMany({ where: { OR: [{ group: { ownerId: userId } }, { userId }] } });
    await tx.group.deleteMany({ where: { ownerId: userId } });

    // Delete other user data
    await tx.notification.deleteMany({ where: { userId } });
    await tx.pushSubscription.deleteMany({ where: { userId } });
    await tx.aiConversation.deleteMany({ where: { userId } });
    await tx.auditLog.deleteMany({ where: { userId } });
    await tx.invitation.deleteMany({ where: { creatorId: userId } });

    // Finally delete the user
    await tx.user.delete({ where: { id: userId } });
  });
}
