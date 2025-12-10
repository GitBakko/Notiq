const webpush = require('web-push');

const publicKey = 'BNfbKWi9nNPT4M8j5vPCNgoeMdaV2LkiryZHkLqBC3e23MthV63hL5f1wDlniwOYVWYYCnqCCwmD7ysWrBb4nDSM';
const privateKey = 'wJGPOOJlnrhlj-2M80UWM8gSfCgxyDYhQivn35abYIk';

try {
  webpush.setVapidDetails(
    'mailto:support@notiq.app',
    publicKey,
    privateKey
  );
  console.log('VAPID details set successfully.');
} catch (error) {
  console.error('Error setting VAPID details:', error.message);
}
