import prisma from '../plugins/prisma';
import { NotFoundError, ForbiddenError, BadRequestError, ConflictError } from '../utils/errors';
import logger from '../utils/logger';
import { createNotification } from './notification.service';

const userSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  color: true,
};

function orderedIds(id1: string, id2: string): [string, string] {
  return id1 < id2 ? [id1, id2] : [id2, id1];
}

export async function getFriends(userId: string) {
  const friendships = await prisma.friendship.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { userAId: userId },
        { userBId: userId },
      ],
    },
    include: {
      userA: { select: userSelect },
      userB: { select: userSelect },
    },
  });

  return friendships.map((f) =>
    f.userAId === userId ? f.userB : f.userA
  );
}

export async function getFriendship(userId: string, friendId: string) {
  const [userAId, userBId] = orderedIds(userId, friendId);
  return prisma.friendship.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });
}

export async function createFriendship(userId: string, friendId: string) {
  const [userAId, userBId] = orderedIds(userId, friendId);

  const existing = await prisma.friendship.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });

  if (existing) {
    if (existing.status === 'ACTIVE') {
      return existing;
    }
    if (existing.status === 'BLOCKED_BY_A' || existing.status === 'BLOCKED_BY_B') {
      throw new ForbiddenError('friendship.errors.blocked');
    }
  }

  return prisma.friendship.create({
    data: { userAId, userBId, status: 'ACTIVE' },
  });
}

export async function sendFriendRequest(fromId: string, toId: string) {
  if (fromId === toId) {
    throw new BadRequestError('friendship.errors.cannotAddSelf');
  }

  // Check no existing active friendship
  const friendship = await getFriendship(fromId, toId);
  if (friendship?.status === 'ACTIVE') {
    throw new ConflictError('friendship.errors.alreadyFriends');
  }
  if (friendship?.status === 'BLOCKED_BY_A' || friendship?.status === 'BLOCKED_BY_B') {
    throw new ForbiddenError('friendship.errors.blocked');
  }

  // Check no existing pending request in either direction
  const existingRequest = await prisma.friendRequest.findFirst({
    where: {
      status: 'PENDING',
      OR: [
        { fromId, toId },
        { fromId: toId, toId: fromId },
      ],
    },
  });
  if (existingRequest) {
    throw new ConflictError('friendship.errors.requestAlreadyPending');
  }

  const request = await prisma.friendRequest.create({
    data: { fromId, toId, status: 'PENDING' },
  });

  // Notify target user
  const sender = await prisma.user.findUnique({
    where: { id: fromId },
    select: { name: true, email: true },
  });
  const senderName = sender?.name || sender?.email || 'Someone';

  await createNotification(
    toId,
    'SYSTEM',
    senderName,
    'Friend request',
    { requestId: request.id, fromId, localizationKey: 'notifications.friendRequest', localizationArgs: { senderName } }
  );

  logger.info({ fromId, toId, requestId: request.id }, 'Friend request sent');
  return request;
}

export async function acceptFriendRequest(requestId: string, userId: string) {
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new NotFoundError('friendship.errors.requestNotFound');
  }
  if (request.toId !== userId) {
    throw new ForbiddenError('friendship.errors.notRecipient');
  }
  if (request.status !== 'PENDING') {
    throw new BadRequestError('friendship.errors.requestNotPending');
  }

  await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status: 'ACCEPTED' },
  });

  const friendship = await createFriendship(userId, request.fromId);

  // Notify the sender that their request was accepted
  const accepter = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, email: true },
  });
  const accepterName = accepter?.name || accepter?.email || 'Someone';

  await createNotification(
    request.fromId,
    'SYSTEM',
    accepterName,
    'Friend request accepted',
    { friendshipId: friendship.id, userId, localizationKey: 'notifications.friendRequestAccepted', localizationArgs: { accepterName } }
  );

  logger.info({ requestId, userId, friendId: request.fromId }, 'Friend request accepted');
  return friendship;
}

export async function declineFriendRequest(requestId: string, userId: string) {
  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    throw new NotFoundError('friendship.errors.requestNotFound');
  }
  if (request.toId !== userId) {
    throw new ForbiddenError('friendship.errors.notRecipient');
  }
  if (request.status !== 'PENDING') {
    throw new BadRequestError('friendship.errors.requestNotPending');
  }

  await prisma.friendRequest.update({
    where: { id: requestId },
    data: { status: 'DECLINED' },
  });

  logger.info({ requestId, userId }, 'Friend request declined');
}

export async function getPendingRequests(userId: string) {
  const requests = await prisma.friendRequest.findMany({
    where: { toId: userId, status: 'PENDING' },
    include: {
      from: { select: userSelect },
    },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    from: r.from,
  }));
}

export async function getSentRequests(userId: string) {
  const requests = await prisma.friendRequest.findMany({
    where: { fromId: userId, status: 'PENDING' },
    include: {
      to: { select: userSelect },
    },
    orderBy: { createdAt: 'desc' },
  });

  return requests.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    to: r.to,
  }));
}

export async function blockFriend(userId: string, friendId: string) {
  const [userAId, userBId] = orderedIds(userId, friendId);
  const blockedStatus = userId === userAId ? 'BLOCKED_BY_A' : 'BLOCKED_BY_B';

  await prisma.$transaction(async (tx) => {
    // Update or create friendship with blocked status
    await tx.friendship.upsert({
      where: { userAId_userBId: { userAId, userBId } },
      update: { status: blockedStatus },
      create: { userAId, userBId, status: blockedStatus },
    });

    // Find DIRECT conversation between the two users
    const conversation = await tx.conversation.findFirst({
      where: {
        type: 'DIRECT',
        AND: [
          { participants: { some: { userId } } },
          { participants: { some: { userId: friendId } } },
        ],
      },
      select: { id: true },
    });

    if (conversation) {
      // Delete all messages first, then the conversation
      await tx.directMessage.deleteMany({
        where: { conversationId: conversation.id },
      });
      await tx.conversation.delete({
        where: { id: conversation.id },
      });
    }
  });

  logger.info({ userId, friendId, blockedStatus }, 'User blocked');
}

export async function unblockFriend(userId: string, friendId: string) {
  const [userAId, userBId] = orderedIds(userId, friendId);

  const friendship = await prisma.friendship.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });

  if (!friendship) {
    throw new NotFoundError('friendship.errors.notFound');
  }

  // Verify the blocker is the current user
  const isBlockerA = friendship.status === 'BLOCKED_BY_A' && userId === userAId;
  const isBlockerB = friendship.status === 'BLOCKED_BY_B' && userId === userBId;

  if (!isBlockerA && !isBlockerB) {
    throw new ForbiddenError('friendship.errors.notBlocker');
  }

  await prisma.friendship.update({
    where: { userAId_userBId: { userAId, userBId } },
    data: { status: 'ACTIVE' },
  });

  logger.info({ userId, friendId }, 'User unblocked');
}

export async function isBlocked(userId: string, friendId: string): Promise<boolean> {
  const friendship = await getFriendship(userId, friendId);
  if (!friendship) return false;
  return friendship.status === 'BLOCKED_BY_A' || friendship.status === 'BLOCKED_BY_B';
}

export async function getAutoFriendCandidates(userId: string) {
  // Get existing friends and blocked users to exclude
  const existingFriendships = await prisma.friendship.findMany({
    where: {
      OR: [
        { userAId: userId },
        { userBId: userId },
      ],
    },
    select: { userAId: true, userBId: true },
  });

  const excludeIds = new Set<string>([userId]);
  for (const f of existingFriendships) {
    excludeIds.add(f.userAId);
    excludeIds.add(f.userBId);
  }

  // Find users that share items with this user (ACCEPTED status)
  const [sharedNoteUsers, sharedNotebookUsers, sharedTaskListUsers, sharedKanbanUsers, groupMembers] = await Promise.all([
    // Users who share notes with me (note owners) or I share with (shared users)
    prisma.sharedNote.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userId },
          { note: { userId } },
        ],
      },
      include: {
        user: { select: userSelect },
        note: { include: { user: { select: userSelect } } },
      },
    }),
    prisma.sharedNotebook.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userId },
          { notebook: { userId } },
        ],
      },
      include: {
        user: { select: userSelect },
        notebook: { include: { user: { select: userSelect } } },
      },
    }),
    prisma.sharedTaskList.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userId },
          { taskList: { userId } },
        ],
      },
      include: {
        user: { select: userSelect },
        taskList: { include: { user: { select: userSelect } } },
      },
    }),
    prisma.sharedKanbanBoard.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { userId },
          { board: { ownerId: userId } },
        ],
      },
      include: {
        user: { select: userSelect },
        board: { include: { owner: { select: userSelect } } },
      },
    }),
    // Users in same groups
    prisma.groupMember.findMany({
      where: {
        group: {
          members: { some: { userId } },
        },
        NOT: { userId },
      },
      include: {
        user: { select: userSelect },
      },
    }),
  ]);

  const candidateMap = new Map<string, typeof userSelect extends infer T ? { [K in keyof T]: unknown } : never>();

  // Collect from shared notes
  for (const sn of sharedNoteUsers) {
    if (sn.userId === userId) {
      // I'm the share recipient, note owner is candidate
      const owner = sn.note.user;
      if (!excludeIds.has(owner.id)) candidateMap.set(owner.id, owner);
    } else {
      // I'm the note owner, shared user is candidate
      if (!excludeIds.has(sn.user.id)) candidateMap.set(sn.user.id, sn.user);
    }
  }

  // Collect from shared notebooks
  for (const sn of sharedNotebookUsers) {
    if (sn.userId === userId) {
      const owner = sn.notebook.user;
      if (!excludeIds.has(owner.id)) candidateMap.set(owner.id, owner);
    } else {
      if (!excludeIds.has(sn.user.id)) candidateMap.set(sn.user.id, sn.user);
    }
  }

  // Collect from shared task lists
  for (const st of sharedTaskListUsers) {
    if (st.userId === userId) {
      const owner = st.taskList.user;
      if (!excludeIds.has(owner.id)) candidateMap.set(owner.id, owner);
    } else {
      if (!excludeIds.has(st.user.id)) candidateMap.set(st.user.id, st.user);
    }
  }

  // Collect from shared kanban boards
  for (const sk of sharedKanbanUsers) {
    if (sk.userId === userId) {
      const owner = sk.board.owner;
      if (!excludeIds.has(owner.id)) candidateMap.set(owner.id, owner);
    } else {
      if (!excludeIds.has(sk.user.id)) candidateMap.set(sk.user.id, sk.user);
    }
  }

  // Collect from group members
  for (const gm of groupMembers) {
    if (!excludeIds.has(gm.user.id)) {
      candidateMap.set(gm.user.id, gm.user);
    }
  }

  return Array.from(candidateMap.values());
}
