self.addEventListener('push', function (event) {
  if (event.data) {
    const payload = JSON.parse(event.data.text());

    const options = {
      body: payload.body,
      icon: '/icon-192x192.png',
      badge: '/badge-72x72.png',
      data: payload.data,
      vibrate: [100, 50, 100],
      actions: [
        {
          action: 'open',
          title: 'Open App'
        }
      ]
    };

    event.waitUntil(
      self.registration.showNotification(payload.title, options)
    );
  }
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();

  var data = event.notification.data || {};
  var targetUrl = data.noteId ? '/notes?id=' + data.noteId : '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      // Try to focus an existing window and navigate it
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.focus();
          if (client.navigate) {
            return client.navigate(targetUrl);
          }
          return;
        }
      }
      // No existing window, open a new one
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    })
  );
});
