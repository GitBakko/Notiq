import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../../plugins/prisma';

// Mock web-push before importing the service
const mockSendNotification = vi.fn();
const mockSetVapidDetails = vi.fn();

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: mockSetVapidDetails,
    sendNotification: mockSendNotification,
  },
}));

// Set VAPID keys before importing the service so the module-level guard passes
process.env.VAPID_PUBLIC_KEY = 'test-public-vapid-key';
process.env.VAPID_PRIVATE_KEY = 'test-private-vapid-key';

// Import after mocks and env vars are set
const { subscribeUser, sendPushNotification } = await import('../push.service');

const prismaMock = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// subscribeUser
// ---------------------------------------------------------------------------
describe('subscribeUser', () => {
  const subscriptionInput = {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
    keys: {
      p256dh: 'test-p256dh-key',
      auth: 'test-auth-key',
    },
  };

  it('creates a push subscription for the user', async () => {
    const created = {
      id: 'sub-1',
      userId: 'user-1',
      endpoint: subscriptionInput.endpoint,
      keys: subscriptionInput.keys,
    };
    prismaMock.pushSubscription.create.mockResolvedValue(created);

    const result = await subscribeUser('user-1', subscriptionInput);

    expect(prismaMock.pushSubscription.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        endpoint: subscriptionInput.endpoint,
        keys: subscriptionInput.keys,
      },
    });
    expect(result).toEqual(created);
  });

  it('passes different users and endpoints correctly', async () => {
    const otherSubscription = {
      endpoint: 'https://push.example.com/sub/xyz',
      keys: { p256dh: 'other-p256dh', auth: 'other-auth' },
    };
    prismaMock.pushSubscription.create.mockResolvedValue({
      id: 'sub-2',
      userId: 'user-2',
      ...otherSubscription,
    });

    await subscribeUser('user-2', otherSubscription);

    expect(prismaMock.pushSubscription.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-2',
        endpoint: otherSubscription.endpoint,
        keys: otherSubscription.keys,
      },
    });
  });

  it('propagates database errors', async () => {
    prismaMock.pushSubscription.create.mockRejectedValue(new Error('DB error'));

    await expect(subscribeUser('user-1', subscriptionInput))
      .rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// sendPushNotification
// ---------------------------------------------------------------------------
describe('sendPushNotification', () => {
  const payload = {
    title: 'New Message',
    body: 'You have a new notification',
    data: { url: '/notes/123' },
  };

  it('sends notifications to all user subscriptions', async () => {
    const subscriptions = [
      {
        id: 'sub-1',
        endpoint: 'https://fcm.googleapis.com/send/abc',
        keys: { p256dh: 'key1-p256dh', auth: 'key1-auth' },
      },
      {
        id: 'sub-2',
        endpoint: 'https://fcm.googleapis.com/send/def',
        keys: { p256dh: 'key2-p256dh', auth: 'key2-auth' },
      },
    ];

    prismaMock.pushSubscription.findMany.mockResolvedValue(subscriptions);
    mockSendNotification.mockResolvedValue({});

    await sendPushNotification('user-1', payload);

    expect(prismaMock.pushSubscription.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
    expect(mockSendNotification).toHaveBeenCalledWith(
      { endpoint: subscriptions[0].endpoint, keys: subscriptions[0].keys },
      JSON.stringify(payload),
    );
    expect(mockSendNotification).toHaveBeenCalledWith(
      { endpoint: subscriptions[1].endpoint, keys: subscriptions[1].keys },
      JSON.stringify(payload),
    );
  });

  it('does nothing when user has no subscriptions', async () => {
    prismaMock.pushSubscription.findMany.mockResolvedValue([]);

    await sendPushNotification('user-1', payload);

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it('deletes subscription when web-push returns 410 (Gone)', async () => {
    const sub = {
      id: 'sub-expired',
      endpoint: 'https://fcm.googleapis.com/send/expired',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    };
    prismaMock.pushSubscription.findMany.mockResolvedValue([sub]);

    const goneError = new Error('Push subscription has expired');
    (goneError as any).statusCode = 410;
    mockSendNotification.mockRejectedValue(goneError);
    prismaMock.pushSubscription.delete.mockResolvedValue(sub);

    await sendPushNotification('user-1', payload);

    expect(prismaMock.pushSubscription.delete).toHaveBeenCalledWith({
      where: { id: 'sub-expired' },
    });
  });

  it('does not delete subscription for non-410 errors', async () => {
    const sub = {
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/send/abc',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    };
    prismaMock.pushSubscription.findMany.mockResolvedValue([sub]);

    const serverError = new Error('Internal server error');
    (serverError as any).statusCode = 500;
    mockSendNotification.mockRejectedValue(serverError);

    await sendPushNotification('user-1', payload);

    expect(prismaMock.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('does not delete subscription for errors without statusCode', async () => {
    const sub = {
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/send/abc',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    };
    prismaMock.pushSubscription.findMany.mockResolvedValue([sub]);

    mockSendNotification.mockRejectedValue(new Error('Network error'));

    await sendPushNotification('user-1', payload);

    expect(prismaMock.pushSubscription.delete).not.toHaveBeenCalled();
  });

  it('handles mixed success and failure across subscriptions', async () => {
    const subscriptions = [
      {
        id: 'sub-ok',
        endpoint: 'https://fcm.googleapis.com/send/ok',
        keys: { p256dh: 'key1-p256dh', auth: 'key1-auth' },
      },
      {
        id: 'sub-expired',
        endpoint: 'https://fcm.googleapis.com/send/expired',
        keys: { p256dh: 'key2-p256dh', auth: 'key2-auth' },
      },
      {
        id: 'sub-error',
        endpoint: 'https://fcm.googleapis.com/send/error',
        keys: { p256dh: 'key3-p256dh', auth: 'key3-auth' },
      },
    ];

    prismaMock.pushSubscription.findMany.mockResolvedValue(subscriptions);

    const goneError = new Error('Gone');
    (goneError as any).statusCode = 410;

    mockSendNotification
      .mockResolvedValueOnce({})               // sub-ok succeeds
      .mockRejectedValueOnce(goneError)         // sub-expired gets 410
      .mockRejectedValueOnce(new Error('Fail')); // sub-error fails generically

    prismaMock.pushSubscription.delete.mockResolvedValue({});

    await sendPushNotification('user-1', payload);

    // Only the 410 subscription should be deleted
    expect(prismaMock.pushSubscription.delete).toHaveBeenCalledTimes(1);
    expect(prismaMock.pushSubscription.delete).toHaveBeenCalledWith({
      where: { id: 'sub-expired' },
    });
  });

  it('sends payload without data field when not provided', async () => {
    const simplePayload = { title: 'Alert', body: 'Something happened' };
    const sub = {
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/send/abc',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    };

    prismaMock.pushSubscription.findMany.mockResolvedValue([sub]);
    mockSendNotification.mockResolvedValue({});

    await sendPushNotification('user-1', simplePayload);

    expect(mockSendNotification).toHaveBeenCalledWith(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(simplePayload),
    );
  });

  it('does not throw even when all notifications fail', async () => {
    const sub = {
      id: 'sub-1',
      endpoint: 'https://fcm.googleapis.com/send/abc',
      keys: { p256dh: 'key-p256dh', auth: 'key-auth' },
    };
    prismaMock.pushSubscription.findMany.mockResolvedValue([sub]);
    mockSendNotification.mockRejectedValue(new Error('Total failure'));

    // Should not throw — errors are caught internally
    await expect(sendPushNotification('user-1', payload)).resolves.toBeUndefined();
  });
});
