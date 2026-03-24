// Push notification handler — imported by the generated service worker

self.addEventListener('push', function(event) {
  if (!event.data) return;

  var data = event.data.json();
  var options = {
    body: data.body,
    icon: '/mobile/icon-192.png',
    badge: '/mobile/icon-192.png',
    tag: data.tag || 'octopus',
    data: data.data,
    vibrate: [200, 100, 200],
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  var agentId = event.notification.data && event.notification.data.agentId;
  var url = agentId ? '/mobile/chat/' + agentId : '/mobile/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var client = clientList[i];
        if ('focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
