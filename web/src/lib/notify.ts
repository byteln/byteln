/** Browser notifications for partner activity while this tab is backgrounded. */

export type NotifyPermission = NotificationPermission | 'unsupported';

export function notificationSupport(): boolean {
	return typeof window !== 'undefined' && 'Notification' in window;
}

export function getNotifyPermission(): NotifyPermission {
	if (!notificationSupport()) return 'unsupported';
	return Notification.permission;
}

export async function ensureNotifyPermission(): Promise<NotifyPermission> {
	if (!notificationSupport()) return 'unsupported';
	if (Notification.permission === 'granted') return 'granted';
	if (Notification.permission === 'denied') return 'denied';
	try {
		return await Notification.requestPermission();
	} catch {
		return Notification.permission;
	}
}

export function notifyPartnerMessage(opts: {
	body: string;
	bucketId: string;
	nickname?: string;
	onClick?: () => void;
}): void {
	if (!notificationSupport() || Notification.permission !== 'granted') return;
	if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
		// Caller decides when to notify for inactive rooms; skip only same-room foreground.
	}

	const label = opts.nickname?.trim() || 'Partner';
	const text = opts.body.length > 120 ? `${opts.body.slice(0, 117)}…` : opts.body;
	const n = new Notification(`byteln · ${label}`, {
		body: text,
		tag: `byteln:${opts.bucketId}`,
		icon: '/favicon.svg'
	});
	n.onclick = () => {
		window.focus();
		opts.onClick?.();
		n.close();
	};
}

export function notifyPartnerJoined(bucketId: string, nickname?: string): void {
	if (!notificationSupport() || Notification.permission !== 'granted') return;
	if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;

	const label = nickname?.trim() || 'Partner';
	const n = new Notification('byteln', {
		body: `${label} joined the chat`,
		tag: `byteln-join:${bucketId}`,
		icon: '/favicon.svg'
	});
	n.onclick = () => {
		window.focus();
		n.close();
	};
}
