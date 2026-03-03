import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../../plugins/prisma';
import {
  makeUser,
  makeKanbanBoard,
  makeKanbanColumn,
  makeKanbanCard,
  makeKanbanComment,
  makeKanbanBoardChat,
  makeSharedKanbanBoard,
} from '../../../__tests__/factories';

// ─── Mock sibling services ──────────────────────────────────────────────

vi.mock('../../notification.service', () => ({
  createNotification: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../email.service', () => ({
  sendNotificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../kanbanSSE', () => ({
  broadcast: vi.fn(),
  getPresenceUsers: vi.fn().mockReturnValue([]),
}));

vi.mock('../notifications', () => ({
  notifyBoardUsersTiered: vi.fn().mockResolvedValue(undefined),
  boardChatEmailDebounce: new Map(),
  BOARD_CHAT_EMAIL_DEBOUNCE_MS: 30 * 60 * 1000,
}));

// ─── Import SUT (after mocks) ─────────────────────────────────────────

import {
  getComments,
  createComment,
  deleteComment,
  getBoardChat,
  createBoardChatMessage,
} from '../comments-chat.service';

import { NotFoundError, ForbiddenError } from '../../../utils/errors';
import { broadcast, getPresenceUsers } from '../../kanbanSSE';
import { notifyBoardUsersTiered } from '../notifications';

// ─── Helpers ────────────────────────────────────────────────────────────

const mockedPrisma = prisma as any;

function commentWithAuthor(comment: ReturnType<typeof makeKanbanComment>, author: ReturnType<typeof makeUser>) {
  return {
    ...comment,
    author: {
      id: author.id,
      name: author.name,
      email: author.email,
      color: author.color,
      avatarUrl: author.avatarUrl,
    },
  };
}

function chatWithAuthor(chat: ReturnType<typeof makeKanbanBoardChat>, author: ReturnType<typeof makeUser>) {
  return {
    ...chat,
    author: {
      id: author.id,
      name: author.name,
      email: author.email,
      color: author.color,
      avatarUrl: author.avatarUrl,
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('comments-chat.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════
  // getComments
  // ═══════════════════════════════════════════════════════

  describe('getComments', () => {
    it('returns paginated comments with author info', async () => {
      const user = makeUser();
      const card = makeKanbanCard();
      const c1 = makeKanbanComment({ cardId: card.id, authorId: user.id });
      const c2 = makeKanbanComment({ cardId: card.id, authorId: user.id });
      const results = [commentWithAuthor(c1, user), commentWithAuthor(c2, user)];

      mockedPrisma.kanbanComment.findMany.mockResolvedValue(results);

      const out = await getComments(card.id, 1, 10);

      expect(out).toEqual(results);
      expect(mockedPrisma.kanbanComment.findMany).toHaveBeenCalledWith({
        where: { cardId: card.id },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 10,
        include: {
          author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      });
    });

    it('returns empty array when there are no comments', async () => {
      mockedPrisma.kanbanComment.findMany.mockResolvedValue([]);

      const out = await getComments('nonexistent-card', 1, 20);

      expect(out).toEqual([]);
    });

    it('calculates skip correctly for page > 1', async () => {
      mockedPrisma.kanbanComment.findMany.mockResolvedValue([]);

      await getComments('card-id', 3, 5);

      expect(mockedPrisma.kanbanComment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 5 })
      );
    });
  });

  // ═══════════════════════════════════════════════════════
  // createComment
  // ═══════════════════════════════════════════════════════

  describe('createComment', () => {
    it('creates comment and returns it with author', async () => {
      const user = makeUser();
      const board = makeKanbanBoard({ ownerId: user.id });
      const col = makeKanbanColumn({ boardId: board.id });
      const card = makeKanbanCard({ columnId: col.id });

      mockedPrisma.kanbanCard.findUnique.mockResolvedValue({
        title: card.title,
        assigneeId: null,
        column: { boardId: board.id },
      });

      const comment = makeKanbanComment({ cardId: card.id, authorId: user.id, content: 'Hello' });
      const withAuthor = commentWithAuthor(comment, user);
      mockedPrisma.kanbanComment.create.mockResolvedValue(withAuthor);

      const result = await createComment(card.id, user.id, 'Hello');

      expect(result).toEqual(withAuthor);
      expect(mockedPrisma.kanbanComment.create).toHaveBeenCalledWith({
        data: { cardId: card.id, authorId: user.id, content: 'Hello' },
        include: {
          author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      });
    });

    it('throws NotFoundError when card does not exist', async () => {
      mockedPrisma.kanbanCard.findUnique.mockResolvedValue(null);

      await expect(createComment('missing-card', 'user-1', 'Hi'))
        .rejects.toThrow(NotFoundError);
      await expect(createComment('missing-card', 'user-1', 'Hi'))
        .rejects.toThrow('errors.kanban.cardNotFound');
    });

    it('broadcasts comment:added event after creation', async () => {
      const user = makeUser();
      const boardId = 'board-123';

      mockedPrisma.kanbanCard.findUnique.mockResolvedValue({
        title: 'Test Card',
        assigneeId: null,
        column: { boardId },
      });

      const comment = makeKanbanComment({ cardId: 'card-1', authorId: user.id });
      const withAuthor = commentWithAuthor(comment, user);
      mockedPrisma.kanbanComment.create.mockResolvedValue(withAuthor);

      await createComment('card-1', user.id, 'Test');

      expect(broadcast).toHaveBeenCalledWith(boardId, {
        type: 'comment:added',
        boardId,
        cardId: 'card-1',
        comment: withAuthor,
      });
    });

    it('calls notifyBoardUsersTiered with correct args', async () => {
      const user = makeUser({ name: 'Alice' });
      const boardId = 'board-456';

      mockedPrisma.kanbanCard.findUnique.mockResolvedValue({
        title: 'My Card',
        assigneeId: null,
        column: { boardId },
      });

      const comment = makeKanbanComment({ cardId: 'card-2', authorId: user.id, content: 'Nice' });
      const withAuthor = commentWithAuthor(comment, user);
      mockedPrisma.kanbanComment.create.mockResolvedValue(withAuthor);

      await createComment('card-2', user.id, 'Nice');

      expect(notifyBoardUsersTiered).toHaveBeenCalledWith(
        user.id,
        boardId,
        'KANBAN_COMMENT_ADDED',
        'New Comment',
        `Alice commented on "My Card"`,
        expect.objectContaining({
          boardId,
          cardId: 'card-2',
          cardTitle: 'My Card',
          commenterName: 'Alice',
          localizationKey: 'notifications.kanbanCommentAdded',
        }),
        expect.objectContaining({ type: 'KANBAN_COMMENT' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════
  // deleteComment
  // ═══════════════════════════════════════════════════════

  describe('deleteComment', () => {
    it('deletes own comment and broadcasts deletion', async () => {
      const user = makeUser({ name: 'Bob' });
      const boardId = 'board-del-1';
      const cardId = 'card-del-1';

      mockedPrisma.kanbanComment.findUnique.mockResolvedValue({
        authorId: user.id,
        content: 'To delete',
        card: { id: cardId, title: 'Card Title', column: { boardId } },
        author: { name: user.name, email: user.email },
      });
      mockedPrisma.kanbanComment.delete.mockResolvedValue({});

      await deleteComment('comment-1', user.id);

      expect(mockedPrisma.kanbanComment.delete).toHaveBeenCalledWith({ where: { id: 'comment-1' } });
      expect(broadcast).toHaveBeenCalledWith(boardId, {
        type: 'comment:deleted',
        boardId,
        cardId,
        commentId: 'comment-1',
      });
    });

    it('throws NotFoundError when comment does not exist', async () => {
      mockedPrisma.kanbanComment.findUnique.mockResolvedValue(null);

      await expect(deleteComment('missing', 'user-1'))
        .rejects.toThrow(NotFoundError);
      await expect(deleteComment('missing', 'user-1'))
        .rejects.toThrow('errors.kanban.commentNotFound');
    });

    it('throws ForbiddenError when deleting another user\'s comment', async () => {
      const otherUserId = 'other-user';

      mockedPrisma.kanbanComment.findUnique.mockResolvedValue({
        authorId: otherUserId,
        content: 'Not yours',
        card: { id: 'card-1', title: 'Card', column: { boardId: 'board-1' } },
        author: { name: 'Other', email: 'other@test.com' },
      });

      await expect(deleteComment('comment-2', 'my-user-id'))
        .rejects.toThrow(ForbiddenError);
      await expect(deleteComment('comment-2', 'my-user-id'))
        .rejects.toThrow('errors.kanban.notYourComment');
    });

    it('calls notifyBoardUsersTiered for comment deletion', async () => {
      const user = makeUser({ name: 'Carol' });
      const boardId = 'board-del-2';
      const cardId = 'card-del-2';

      mockedPrisma.kanbanComment.findUnique.mockResolvedValue({
        authorId: user.id,
        content: 'Deleted content',
        card: { id: cardId, title: 'My Card', column: { boardId } },
        author: { name: user.name, email: user.email },
      });
      mockedPrisma.kanbanComment.delete.mockResolvedValue({});

      await deleteComment('comment-del', user.id);

      expect(notifyBoardUsersTiered).toHaveBeenCalledWith(
        user.id,
        boardId,
        'KANBAN_COMMENT_DELETED',
        'Comment Deleted',
        `Carol deleted a comment on "My Card"`,
        expect.objectContaining({
          boardId,
          cardId,
          cardTitle: 'My Card',
          deleterName: 'Carol',
          localizationKey: 'notifications.kanbanCommentDeleted',
        }),
        expect.objectContaining({ type: 'KANBAN_COMMENT_DELETED' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════
  // getBoardChat
  // ═══════════════════════════════════════════════════════

  describe('getBoardChat', () => {
    it('returns paginated chat messages with author info', async () => {
      const user = makeUser();
      const boardId = 'board-chat-1';
      const msg1 = makeKanbanBoardChat({ boardId, authorId: user.id });
      const msg2 = makeKanbanBoardChat({ boardId, authorId: user.id });
      const results = [chatWithAuthor(msg1, user), chatWithAuthor(msg2, user)];

      mockedPrisma.kanbanBoardChat.findMany.mockResolvedValue(results);

      const out = await getBoardChat(boardId, 1, 10);

      expect(out).toEqual(results);
      expect(mockedPrisma.kanbanBoardChat.findMany).toHaveBeenCalledWith({
        where: { boardId },
        orderBy: { createdAt: 'asc' },
        skip: 0,
        take: 10,
        include: {
          author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      });
    });

    it('returns empty array when no chat messages exist', async () => {
      mockedPrisma.kanbanBoardChat.findMany.mockResolvedValue([]);

      const out = await getBoardChat('empty-board', 1, 20);

      expect(out).toEqual([]);
    });

    it('calculates skip correctly for page > 1', async () => {
      mockedPrisma.kanbanBoardChat.findMany.mockResolvedValue([]);

      await getBoardChat('board-id', 2, 15);

      expect(mockedPrisma.kanbanBoardChat.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 15, take: 15 })
      );
    });
  });

  // ═══════════════════════════════════════════════════════
  // createBoardChatMessage
  // ═══════════════════════════════════════════════════════

  describe('createBoardChatMessage', () => {
    it('creates chat message and returns it with author', async () => {
      const user = makeUser();
      const boardId = 'board-msg-1';
      const chatMsg = makeKanbanBoardChat({ boardId, authorId: user.id, content: 'Hello board' });
      const withAuthor = chatWithAuthor(chatMsg, user);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue(null); // No board = early return

      const result = await createBoardChatMessage(boardId, user.id, 'Hello board');

      expect(result).toEqual(withAuthor);
      expect(mockedPrisma.kanbanBoardChat.create).toHaveBeenCalledWith({
        data: { boardId, authorId: user.id, content: 'Hello board' },
        include: {
          author: { select: { id: true, name: true, email: true, color: true, avatarUrl: true } },
        },
      });
    });

    it('broadcasts chat:message event', async () => {
      const user = makeUser();
      const boardId = 'board-broadcast';
      const chatMsg = makeKanbanBoardChat({ boardId, authorId: user.id });
      const withAuthor = chatWithAuthor(chatMsg, user);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue(null);

      await createBoardChatMessage(boardId, user.id, 'Test');

      expect(broadcast).toHaveBeenCalledWith(boardId, {
        type: 'chat:message',
        boardId,
        message: withAuthor,
      });
    });

    it('sends notifications to board participants who are offline', async () => {
      const { createNotification } = await import('../../notification.service');
      const author = makeUser({ name: 'Sender' });
      const recipient = makeUser();
      const boardId = 'board-notify';

      const chatMsg = makeKanbanBoardChat({ boardId, authorId: author.id, content: 'Msg content' });
      const withAuthor = chatWithAuthor(chatMsg, author);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);

      // Board with owner + no shares — owner is the recipient
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue({
        title: 'Test Board',
        ownerId: recipient.id,
        shares: [],
      });

      // getPresenceUsers returns empty (no one active on board SSE)
      (getPresenceUsers as any).mockReturnValue([]);

      // Recipient is offline (lastActiveAt > 5 min ago)
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockedPrisma.user.findUnique.mockResolvedValue({
        lastActiveAt: tenMinutesAgo,
        email: recipient.email,
        locale: 'en',
        emailNotificationsEnabled: true,
      });

      await createBoardChatMessage(boardId, author.id, 'Msg content');

      expect(createNotification).toHaveBeenCalledWith(
        recipient.id,
        'KANBAN_COMMENT_ADDED',
        'Board Chat',
        expect.stringContaining('Sender'),
        expect.objectContaining({
          boardId,
          boardTitle: 'Test Board',
          authorName: 'Sender',
          localizationKey: 'notifications.kanbanBoardChat',
        }),
      );
    });

    it('skips notification for users who are active on board SSE', async () => {
      const { createNotification } = await import('../../notification.service');
      const author = makeUser();
      const owner = makeUser();
      const boardId = 'board-sse-skip';

      const chatMsg = makeKanbanBoardChat({ boardId, authorId: author.id });
      const withAuthor = chatWithAuthor(chatMsg, author);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue({
        title: 'Board',
        ownerId: owner.id,
        shares: [],
      });

      // Owner is present on board SSE
      (getPresenceUsers as any).mockReturnValue([{ id: owner.id }]);

      await createBoardChatMessage(boardId, author.id, 'Test');

      // Should NOT have called createNotification for the owner (they're on the board)
      expect(createNotification).not.toHaveBeenCalled();
    });

    it('returns message even if board is not found (early return)', async () => {
      const user = makeUser();
      const boardId = 'board-missing';
      const chatMsg = makeKanbanBoardChat({ boardId, authorId: user.id });
      const withAuthor = chatWithAuthor(chatMsg, user);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue(null);

      const result = await createBoardChatMessage(boardId, user.id, 'Test');

      // Should still return the message (notifications are just skipped)
      expect(result).toEqual(withAuthor);
    });

    it('sends email for offline users with email notifications enabled', async () => {
      const emailService = await import('../../email.service');
      const author = makeUser({ name: 'EmailAuthor' });
      const recipient = makeUser({ emailNotificationsEnabled: true });
      const boardId = 'board-email';

      const chatMsg = makeKanbanBoardChat({ boardId, authorId: author.id, content: 'Email me' });
      const withAuthor = chatWithAuthor(chatMsg, author);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue({
        title: 'Email Board',
        ownerId: recipient.id,
        shares: [],
      });

      (getPresenceUsers as any).mockReturnValue([]);

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockedPrisma.user.findUnique.mockResolvedValue({
        lastActiveAt: tenMinutesAgo,
        email: recipient.email,
        locale: 'en',
        emailNotificationsEnabled: true,
      });

      await createBoardChatMessage(boardId, author.id, 'Email me');

      expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
        recipient.email,
        'CHAT_MESSAGE',
        expect.objectContaining({
          noteId: boardId,
          noteTitle: 'Email Board',
          senderName: 'EmailAuthor',
          messageContent: 'Email me',
          locale: 'en',
        }),
      );
    });

    it('does NOT send email when user has emailNotificationsEnabled=false', async () => {
      const emailService = await import('../../email.service');
      const author = makeUser({ name: 'NoEmail' });
      const recipient = makeUser();
      const boardId = 'board-no-email';

      const chatMsg = makeKanbanBoardChat({ boardId, authorId: author.id });
      const withAuthor = chatWithAuthor(chatMsg, author);

      mockedPrisma.kanbanBoardChat.create.mockResolvedValue(withAuthor);
      mockedPrisma.kanbanBoard.findUnique.mockResolvedValue({
        title: 'Board',
        ownerId: recipient.id,
        shares: [],
      });

      (getPresenceUsers as any).mockReturnValue([]);

      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      mockedPrisma.user.findUnique.mockResolvedValue({
        lastActiveAt: tenMinutesAgo,
        email: recipient.email,
        locale: 'en',
        emailNotificationsEnabled: false,
      });

      await createBoardChatMessage(boardId, author.id, 'Test');

      expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    });
  });
});
