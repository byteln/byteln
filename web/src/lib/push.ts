/**
 * Content-free Web Push via the relay. The relay only learns this browser's
 * push endpoint (for as long as the bucket lives) and sends empty pushes; the
 * service worker shows a generic notice (see static/push-sw.js).
 *
 * A browser holds one push subscription per service worker, bound to one
 * VAPID key. Rooms on relays with a different key than the current owner are
 * skipped rather than thrashing the subscription between relays.
 */

import { getPushEnabled, setPushEnabled } from '$lib/storage/history';

export type PushEndpoint = { endpoint: string };

let enabled = true;
let loaded = false;
const keyCache = new Map<string, Promise<string | null>>();
let ownerBase: string | null = null;
let queue: Promise<unknown> = Promise.resolve();

export function pushSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		'serviceWorker' in navigator &&
		'PushManager' in window &&
		'Notification' in window
	);
}

export async function loadPushPreference(): Promise<boolean> {
	if (loaded) return enabled;
	try {
		enabled = await getPushEnabled();
	} catch {
		/* keep default */
	}
	loaded = true;
	return enabled;
}

export function isPushEnabled(): boolean {
	return enabled;
}

export async function updatePushEnabled(on: boolean): Promise<void> {
	enabled = on;
	loaded = true;
	await setPushEnabled(on);
}

export function relayHttpBase(relayUrl: string): string {
	return relayUrl
		.trim()
		.replace(/\/$/, '')
		.replace(/^ws(s?):\/\//, 'http$1://');
}

function fetchPushKey(base: string): Promise<string | null> {
	let p = keyCache.get(base);
	if (!p) {
		p = fetch(`${base}/push-key`, { cache: 'no-store' })
			.then(async (res) => {
				if (!res.ok) return null;
				const body = (await res.json()) as { enabled?: boolean; key?: string };
				return body.enabled && body.key ? body.key : null;
			})
			.catch(() => {
				keyCache.delete(base);
				return null;
			});
		keyCache.set(base, p);
	}
	return p;
}

function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
	if (!a || a.byteLength !== b.byteLength) return false;
	const av = new Uint8Array(a);
	return av.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
	try {
		return (await navigator.serviceWorker.getRegistration()) ?? null;
	} catch {
		return null;
	}
}

export type PushSubscribeResult = { endpoint: PushEndpoint; renewed: boolean } | null;

/**
 * Returns this browser's push endpoint for a relay, subscribing (or
 * re-subscribing after a relay key rotation) when needed. `renewed` means the
 * endpoint changed, so rooms that registered the old one must re-send.
 */
export function getPushEndpoint(relayUrl: string): Promise<PushSubscribeResult> {
	const run = queue.then(() => subscribeFor(relayHttpBase(relayUrl)));
	queue = run.catch(() => undefined);
	return run.catch(() => null);
}

async function subscribeFor(base: string): Promise<PushSubscribeResult> {
	if (!pushSupported() || Notification.permission !== 'granted') return null;
	if (!(await loadPushPreference())) return null;
	const key = await fetchPushKey(base);
	if (!key) return null;
	const reg = await registration();
	if (!reg) return null;

	const keyBytes = base64UrlToBytes(key);
	const existing = await reg.pushManager.getSubscription();
	if (existing && sameKey(existing.options.applicationServerKey, keyBytes)) {
		ownerBase ??= base;
		return { endpoint: { endpoint: existing.endpoint }, renewed: false };
	}
	if (existing && ownerBase && ownerBase !== base) return null;
	if (existing) await existing.unsubscribe();

	const sub = await reg.pushManager.subscribe({
		userVisibleOnly: true,
		applicationServerKey: keyBytes
	});
	ownerBase = base;
	return { endpoint: { endpoint: sub.endpoint }, renewed: true };
}

export async function unsubscribePush(): Promise<void> {
	ownerBase = null;
	if (!pushSupported()) return;
	const reg = await registration();
	const sub = await reg?.pushManager.getSubscription();
	await sub?.unsubscribe().catch(() => false);
}
