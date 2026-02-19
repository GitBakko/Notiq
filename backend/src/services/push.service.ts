import webpush from 'web-push';
import prisma from '../plugins/prisma';
import logger from '../utils/logger';

const publicVapidKey = process.env.VAPID_PUBLIC_KEY;
const privateVapidKey = process.env.VAPID_PRIVATE_KEY;

if (publicVapidKey && privateVapidKey) {
  webpush.setVapidDetails(
    'mailto:support@notiq.app',
    publicVapidKey,
    privateVapidKey
  );
} else {
  logger.warn('VAPID keys not configured. Push notifications disabled.');
}

export const subscribeUser = async (userId: string, subscription: any) => {
  if (!publicVapidKey || !privateVapidKey) {
    throw new Error('Push notifications are not configured');
  }

  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    },
  });
};

export const sendPushNotification = async (userId: string, payload: any) => {
  if (!publicVapidKey || !privateVapidKey) return;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
  });

  const notifications = subscriptions.map((sub: any) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: sub.keys as any,
    };

    return webpush.sendNotification(pushSubscription, JSON.stringify(payload))
      .catch(async (error) => {
        if (error.statusCode === 410) {
          // Subscription is no longer valid, delete it
          await prisma.pushSubscription.delete({
            where: { id: sub.id },
          });
        }
        logger.error(error, 'Error sending push notification');
      });
  });

  await Promise.all(notifications);
};
