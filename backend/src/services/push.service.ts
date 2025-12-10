import webpush from 'web-push';
import prisma from '../plugins/prisma';

// VAPID Keys should be in environment variables in production
const publicVapidKey = 'BIW6zpzJ20tsygTbA-FOGCNxT82Y5LGzNG2XV_qO2Q0D9FFC1yolwkF06o5NhbA3TJu2Na45777NHxZW_gHRXeU';
const privateVapidKey = 'FvY_Vwpp1eOh8dQiWeuTiHYTJ4hMUNaqhi-77KXp9hs';

webpush.setVapidDetails(
  'mailto:support@notiq.app',
  publicVapidKey,
  privateVapidKey
);

export const subscribeUser = async (userId: string, subscription: any) => {
  return prisma.pushSubscription.create({
    data: {
      userId,
      endpoint: subscription.endpoint,
      keys: subscription.keys,
    },
  });
};

export const sendPushNotification = async (userId: string, payload: any) => {
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
        console.error('Error sending push notification', error);
      });
  });

  await Promise.all(notifications);
};
