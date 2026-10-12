/* Loaded into the generated service worker via workbox importScripts.
 * Relay pushes are payload-free: the service worker cannot decrypt anything
 * (room keys stay in the PIN vault), so it only shows a generic notice. */

self.addEventListener('push', (event) => {
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			if (clients.some((c) => c.focused && c.visibilityState === 'visible')) return;
			return self.registration.showNotification('byteln', {
				body: 'New message in a chat',
				tag: 'byteln-push',
				renotify: true,
				icon: '/pwa-192.png',
				badge: '/pwa-192.png'
			});
		})
	);
});

self.addEventListener('notificationclick', (event) => {
	event.notification.close();
	event.waitUntil(
		self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
			const existing = clients.find((c) => new URL(c.url).origin === self.location.origin);
			if (existing) return existing.focus();
			return self.clients.openWindow('/app');
		})
	);
});
