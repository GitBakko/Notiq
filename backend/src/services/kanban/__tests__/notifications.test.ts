import { describe, it, expect, beforeEach, vi } from 'vitest';
import prisma from '../../../plugins/prisma'; // Auto-mocked by setup.ts

const { mockCreateNotification, mockSendEmail, mockPresence } = vi.hoisted(() => ({
  mockCreateNotification: vi.fn(),
  mockSendEmail: vi.fn(),
  mockPresence: vi.fn(),
}));

vi.mock('../../notification.service', () => ({ createNotification: mockCreateNotification }));
vi.mock('../../email.service', () => ({ sendNotificationEmail: mockSendEmail }));
vi.mock('../../kanbanSSE', () => ({ getPresenceUsers: mockPresence }));

import { notifyBoardUsersTiered, cardActionEmailDebounce } from '../notifications';

const m = vi.mocked;
const longAgo = new Date(Date.now() - 60 * 60 * 1000);
const offline = (id: string) => ({ id, lastActiveAt: longAgo, email: `${id}@example.com`, locale: 'it', emailNotificationsEnabled: true });
const template = { type: 'KANBAN_CARD_MOVED' as const, data: (email: string, locale: string) => ({ email, locale }) };
const notify = () => notifyBoardUsersTiered('actor', 'board-1', 'KANBAN_CARD_MOVED', 'T', 'M', { boardId: 'board-1' }, template);
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  cardActionEmailDebounce.clear();
  mockPresence.mockReturnValue([]);
  mockCreateNotification.mockResolvedValue({});
  mockSendEmail.mockResolvedValue(undefined);
  m(prisma.kanbanBoard.findUnique).mockResolvedValue({
    title: 'Board', ownerId: 'owner', shares: [{ userId: 'u-2' }, { userId: 'u-3' }, { userId: 'actor' }],
  } as never);
  m(prisma.user.findMany).mockResolvedValue([offline('owner'), offline('u-2'), offline('u-3')] as never);
});

// 5.5 — one findUnique per recipient, and every notification awaited the SMTP send:
// the request that moved a card or posted a comment waited on the mail server.
describe('notifyBoardUsersTiered', () => {
  it('reads all recipients with ONE query, never one per recipient', async () => {
    await notify();

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['owner', 'u-2', 'u-3'] } },
    }));
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
  });

  it('does not wait for the mail server', async () => {
    mockSendEmail.mockReturnValue(new Promise(() => {})); // an SMTP server that never answers

    await expect(Promise.race([
      notify().then(() => 'done'),
      new Promise((r) => setTimeout(() => r('timeout'), 200)),
    ])).resolves.toBe('done');
    await flush(); // the sends are dispatched after the function returned
    expect(mockSendEmail).toHaveBeenCalledTimes(3);
  });

  it('never throws when an email fails, and keeps notifying the others', async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('SMTP down'));

    await expect(notify()).resolves.toBeUndefined();
    await flush();
    expect(mockCreateNotification).toHaveBeenCalledTimes(3);
  });

  it('skips users on the board and emails only offline users with email on', async () => {
    mockPresence.mockReturnValue([{ id: 'u-2' }]);
    m(prisma.user.findMany).mockResolvedValue([
      offline('owner'),
      { ...offline('u-3'), lastActiveAt: new Date() }, // online in the app: in-app only
    ] as never);

    await notify();
    await flush();

    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['owner', 'u-3'] } } }));
    expect(mockCreateNotification.mock.calls.map((c) => c[0])).toEqual(['owner', 'u-3']);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith('owner@example.com', 'KANBAN_CARD_MOVED', { email: 'owner@example.com', locale: 'it' });
  });

  it('still debounces emails per user and board', async () => {
    await notify();
    await notify();
    await flush();

    expect(mockSendEmail).toHaveBeenCalledTimes(3); // not 6
  });

  it('releases the debounce when a send fails, so the next event can retry', async () => {
    mockSendEmail.mockRejectedValue(new Error('SMTP down'));
    await notify();
    await flush();
    mockSendEmail.mockResolvedValue(undefined);

    await notify();
    await flush();

    expect(mockSendEmail).toHaveBeenCalledTimes(6);
  });
});
