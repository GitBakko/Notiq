import { useState, useEffect } from 'react';
import api from '../lib/api';

const PUBLIC_VAPID_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || 'BIW6zpzJ20tsygTbA-FOGCNxT82Y5LGzNG2XV_qO2Q0D9FFC1yolwkF06o5NhbA3TJu2Na45777NHxZW_gHRXeU';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');

  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export const usePushNotifications = () => {
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    if ('serviceWorker' in navigator && 'PushManager' in window) {
      navigator.serviceWorker.ready.then(reg => {
        setRegistration(reg);
        reg.pushManager.getSubscription().then(sub => {
          if (sub) {
            setSubscription(sub);
            setIsSubscribed(true);
          }
        });
      });
    }
  }, []);

  const subscribe = async () => {
    if (!registration) return;

    try {
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(PUBLIC_VAPID_KEY)
      });

      await api.post('/notifications/subscribe', sub);
      setSubscription(sub);
      setIsSubscribed(true);
    } catch (error) {
      console.error('Failed to subscribe the user: ', error);
    }
  };

  const unsubscribe = async () => {
    if (!subscription) return;

    try {
      await subscription.unsubscribe();
      // Optionally notify backend to remove subscription
      setSubscription(null);
      setIsSubscribed(false);
    } catch (error) {
      console.error('Failed to unsubscribe the user: ', error);
    }
  };

  return {
    isSubscribed,
    subscribe,
    unsubscribe,
    isSupported: 'serviceWorker' in navigator && 'PushManager' in window
  };
};
