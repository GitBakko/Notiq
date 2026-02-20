import { vi, describe, it, expect, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';

// Mock dependencies that chat.service imports
vi.mock('../notification.service', () => ({
  createNotification: vi.fn(),
}));

vi.mock('../email.service', () => ({
  sendNotificationEmail: vi.fn(),
}));

vi.mock('../../hocuspocus', () => ({
  hocuspocus: {
    documents: new Map(),
  },
}));

import { createMessage, getMessages } from '../chat.service';
import * as notificationService from '../notification.service';
import * as emailService from '../email.service';
import { hocuspocus } from '../../hocuspocus';

const prismaMock = prisma as any;

const USER_ID = 'user-sender';
const NOTE_ID = 'note-1';

beforeEach(() => {
  vi.clearAllMocks();
  // Reset hocuspocus documents map
  (hocuspocus as any).documents = new Map();
});

describe('createMessage', () => {
  const mockMessage = {
    id: 'msg-1',
    userId: USER_ID,
    noteId: NOTE_ID,
    content: 'Hello',
    user: { id: USER_ID, name: 'Sender', email: 'sender@test.com', color: '#fff', avatarUrl: null },
  };

  it('should create a chat message and return it', async () => {
    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);
    prismaMock.note.findUnique.mockResolvedValue(null); // no note found, skips notifications

    const result = await createMessage(USER_ID, NOTE_ID, 'Hello');

    expect(prismaMock.chatMessage.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, noteId: NOTE_ID, content: 'Hello' },
      include: {
        user: {
          select: { id: true, name: true, email: true, color: true, avatarUrl: true },
        },
      },
    });
    expect(result).toEqual(mockMessage);
  });

  it('should return message without notifications when note is not found', async () => {
    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);
    prismaMock.note.findUnique.mockResolvedValue(null);

    const result = await createMessage(USER_ID, NOTE_ID, 'Hello');

    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
    expect(result).toEqual(mockMessage);
  });

  it('should send in-app notification to online owner who is not on the note', async () => {
    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);

    const ownerId = 'owner-1';
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: ownerId,
      title: 'Test Note',
      user: { id: ownerId, email: 'owner@test.com', lastActiveAt: new Date() },
      sharedWith: [],
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ name: 'Sender', email: 'sender@test.com' }) // sender lookup
      .mockResolvedValueOnce({
        lastActiveAt: new Date(), // active now = online
        email: 'owner@test.com',
        locale: 'en',
      });

    await createMessage(USER_ID, NOTE_ID, 'Hello world');

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      ownerId,
      'CHAT_MESSAGE',
      'New Chat Message',
      expect.stringContaining('Sender commented'),
      expect.objectContaining({ noteId: NOTE_ID, senderName: 'Sender' }),
    );
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('should send email to offline owner (not active recently)', async () => {
    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);

    const ownerId = 'owner-1';
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: ownerId,
      title: 'Test Note',
      user: { id: ownerId, email: 'owner@test.com' },
      sharedWith: [],
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ name: 'Sender', email: 'sender@test.com' })
      .mockResolvedValueOnce({
        lastActiveAt: new Date(Date.now() - 10 * 60 * 1000), // 10 min ago = offline
        email: 'owner@test.com',
        locale: 'en',
      });

    await createMessage(USER_ID, NOTE_ID, 'Hello world');

    expect(emailService.sendNotificationEmail).toHaveBeenCalledWith(
      'owner@test.com',
      'CHAT_MESSAGE',
      expect.objectContaining({ noteId: NOTE_ID, senderName: 'Sender' }),
    );
    expect(notificationService.createNotification).not.toHaveBeenCalled();
  });

  it('should skip notification for sender (owner is also sender)', async () => {
    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: USER_ID, // sender is the owner
      title: 'My Note',
      user: { id: USER_ID, email: 'sender@test.com' },
      sharedWith: [],
    });
    prismaMock.user.findUnique.mockResolvedValue({
      name: 'Sender',
      email: 'sender@test.com',
    });

    await createMessage(USER_ID, NOTE_ID, 'Talking to myself');

    // No recipients besides the sender, so no notifications
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('should skip notifications for users active on the note via Hocuspocus', async () => {
    const collaboratorId = 'collab-1';

    // Set up a hocuspocus document with the collaborator connected
    const mockDocument = {
      getConnections: () => [
        { context: { user: { id: collaboratorId } } },
      ],
    };
    (hocuspocus as any).documents = new Map([[NOTE_ID, mockDocument]]);

    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: USER_ID, // sender is owner
      title: 'Shared Note',
      user: { id: USER_ID, email: 'sender@test.com' },
      sharedWith: [
        { userId: collaboratorId, user: { id: collaboratorId, email: 'collab@test.com' } },
      ],
    });
    prismaMock.user.findUnique.mockResolvedValue({
      name: 'Sender',
      email: 'sender@test.com',
    });

    await createMessage(USER_ID, NOTE_ID, 'Check this out');

    // Collaborator is active on the note, so no notification
    expect(notificationService.createNotification).not.toHaveBeenCalled();
    expect(emailService.sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('should truncate long message content in notification', async () => {
    prismaMock.chatMessage.create.mockResolvedValue(mockMessage);

    const ownerId = 'owner-1';
    const longContent = 'A'.repeat(100);
    prismaMock.note.findUnique.mockResolvedValue({
      id: NOTE_ID,
      userId: ownerId,
      title: 'Test Note',
      user: { id: ownerId, email: 'owner@test.com' },
      sharedWith: [],
    });
    prismaMock.user.findUnique
      .mockResolvedValueOnce({ name: 'Sender', email: 'sender@test.com' })
      .mockResolvedValueOnce({
        lastActiveAt: new Date(),
        email: 'owner@test.com',
        locale: 'en',
      });

    await createMessage(USER_ID, NOTE_ID, longContent);

    expect(notificationService.createNotification).toHaveBeenCalledWith(
      ownerId,
      'CHAT_MESSAGE',
      'New Chat Message',
      expect.stringContaining('...'),
      expect.objectContaining({ messageContent: longContent }),
    );
  });
});

describe('getMessages', () => {
  it('should return messages for a note with default pagination', async () => {
    const messages = [
      { id: 'msg-1', content: 'Hello', user: { id: 'u1', name: 'A' } },
      { id: 'msg-2', content: 'World', user: { id: 'u2', name: 'B' } },
    ];
    prismaMock.chatMessage.findMany.mockResolvedValue(messages);

    const result = await getMessages(NOTE_ID);

    expect(prismaMock.chatMessage.findMany).toHaveBeenCalledWith({
      where: { noteId: NOTE_ID },
      orderBy: { createdAt: 'asc' },
      skip: 0,
      take: 100,
      include: {
        user: {
          select: { id: true, name: true, email: true, color: true, avatarUrl: true },
        },
      },
    });
    expect(result).toEqual(messages);
  });

  it('should apply custom pagination parameters', async () => {
    prismaMock.chatMessage.findMany.mockResolvedValue([]);

    await getMessages(NOTE_ID, 3, 25);

    expect(prismaMock.chatMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 50, // (3 - 1) * 25
        take: 25,
      }),
    );
  });
});
