const webpush = require('web-push');

const vapidKeys = webpush.generateVAPIDKeys();
console.log('Generated Keys:');
console.log(JSON.stringify(vapidKeys, null, 2));

try {
  webpush.setVapidDetails(
    'mailto:support@notiq.app',
    vapidKeys.publicKey,
    vapidKeys.privateKey
  );
  console.log('Verification: SUCCESS');
} catch (error) {
  console.error('Verification: FAILED', error.message);
}
