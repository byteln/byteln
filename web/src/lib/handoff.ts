/**
 * Phone → laptop room handoff. The receiving device shows a QR with a fresh
 * relay bucket id + one-time AES key in the URL fragment; the sending device
 * scans it and pushes the room link + PIN through that bucket, encrypted.
 * The relay only ever sees ciphertext on a throwaway bucket.
 */

import { parseRoomFragment, shareRoomHash } from '$lib/crypto/room';
import { base64UrlToBytes, bytesToBase64Url, randomBucketId, randomToken } from '$lib/crypto/session';
import { RelayClient } from '$lib/relay/client';

export type HandoffChannel = {
	channelId: string;
	keyRaw: Uint8Array;
	relayUrl: string;
};

export type HandoffRoom = {
	bucketId: string;
	roomHash: string;
	pin: string;
};

type HandoffMessage = ({ t: 'room' } & HandoffRoom) | { t: 'ack' };

const FRAME_VERSION = 1;
const BUCKET_ID = /^[A-Za-z0-9_-]{4,32}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function buf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out;
}

export function createHandoffChannel(relayUrl: string): HandoffChannel {
	return {
		channelId: randomBucketId(20),
		keyRaw: crypto.getRandomValues(new Uint8Array(32)),
		relayUrl
	};
}

export function handoffUrl(origin: string, ch: HandoffChannel): string {
	const params = new URLSearchParams({
		ch: ch.channelId,
		k: bytesToBase64Url(ch.keyRaw),
		r: ch.relayUrl
	});
	return `${origin}/handoff#${params.toString()}`;
}

export function parseHandoffFragment(hash: string): HandoffChannel | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''));
	const channelId = params.get('ch') ?? '';
	const k = params.get('k') ?? '';
	const relayUrl = params.get('r') ?? '';
	if (!BUCKET_ID.test(channelId) || !/^wss?:\/\//i.test(relayUrl)) return null;
	try {
		const keyRaw = base64UrlToBytes(k);
		if (keyRaw.length !== 32) return null;
		return { channelId, keyRaw, relayUrl };
	} catch {
		return null;
	}
}

/** Pull a handoff fragment out of a scanned QR value (full URL or bare fragment). */
export function parseHandoffScan(value: string): HandoffChannel | null {
	const i = value.indexOf('#');
	if (i < 0) return null;
	try {
		if (i > 0 && !new URL(value).pathname.startsWith('/handoff')) return null;
	} catch {
		return null;
	}
	return parseHandoffFragment(value.slice(i));
}

async function importChannelKey(ch: HandoffChannel): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', buf(ch.keyRaw), { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
}

export async function sealHandoff(ch: HandoffChannel, msg: HandoffMessage): Promise<ArrayBuffer> {
	const key = await importChannelKey(ch);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv, additionalData: encoder.encode(ch.channelId) },
		key,
		encoder.encode(JSON.stringify(msg))
	);
	const out = new Uint8Array(1 + iv.length + ct.byteLength);
	out[0] = FRAME_VERSION;
	out.set(iv, 1);
	out.set(new Uint8Array(ct), 1 + iv.length);
	return out.buffer;
}

export async function openHandoff(ch: HandoffChannel, data: ArrayBuffer): Promise<HandoffMessage | null> {
	const bytes = new Uint8Array(data);
	if (bytes.length < 14 || bytes[0] !== FRAME_VERSION) return null;
	try {
		const key = await importChannelKey(ch);
		const plain = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: bytes.slice(1, 13), additionalData: encoder.encode(ch.channelId) },
			key,
			bytes.slice(13)
		);
		return validateMessage(JSON.parse(decoder.decode(plain)));
	} catch {
		return null;
	}
}

function validateMessage(raw: unknown): HandoffMessage | null {
	if (!raw || typeof raw !== 'object') return null;
	const m = raw as Record<string, unknown>;
	if (m.t === 'ack') return { t: 'ack' };
	if (m.t !== 'room') return null;
	const { bucketId, roomHash, pin } = m;
	if (typeof bucketId !== 'string' || !BUCKET_ID.test(bucketId)) return null;
	if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) return null;
	if (typeof roomHash !== 'string') return null;
	const fragment = parseRoomFragment(roomHash);
	if (!fragment || fragment.legacy) return null;
	return { t: 'room', bucketId, roomHash: shareRoomHash(roomHash), pin };
}

export type HandoffListener = {
	close: () => void;
};

/** Receiving side: wait on the channel for one room, ack it, then hand it to `onRoom`. */
export function listenForHandoff(
	ch: HandoffChannel,
	handlers: {
		onRoom: (room: HandoffRoom) => void;
		onStatus?: (status: 'connecting' | 'open' | 'reconnecting' | 'error') => void;
	}
): HandoffListener {
	const client = new RelayClient(ch.relayUrl, ch.channelId, randomToken(), '');
	let done = false;

	client.onStatus = (s) => {
		if (done) return;
		if (s === 'closed') handlers.onStatus?.('reconnecting');
		else handlers.onStatus?.(s);
	};
	client.onBinary = async (data) => {
		if (done) return;
		const msg = await openHandoff(ch, data);
		if (!msg || msg.t !== 'room' || done) return;
		done = true;
		client.sendBinary(await sealHandoff(ch, { t: 'ack' }));
		await client.closeAndWait();
		handlers.onRoom(msg);
	};
	client.connect();

	return {
		close: () => {
			done = true;
			client.close();
		}
	};
}

export class HandoffError extends Error {}

/** Sending side: push one room to the waiting device and resolve once it acks. */
export function sendHandoff(ch: HandoffChannel, room: HandoffRoom, timeoutMs = 15_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const client = new RelayClient(ch.relayUrl, ch.channelId, randomToken(), '', {
			autoReconnect: false
		});
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			client.close();
			if (err) reject(err);
			else resolve();
		};
		const timer = setTimeout(
			() => finish(new HandoffError('The other device did not answer. Is its QR page still open?')),
			timeoutMs
		);

		client.onStatus = (s, detail) => {
			if (s === 'open') {
				void sealHandoff(ch, { t: 'room', ...room }).then((frame) => client.sendBinary(frame));
				return;
			}
			if (s === 'closed' || s === 'error') {
				finish(
					new HandoffError(
						detail === 'bucket full'
							? 'This QR code was already used. Refresh it on the other device.'
							: 'Could not reach the relay.'
					)
				);
			}
		};
		client.onBinary = async (data) => {
			const msg = await openHandoff(ch, data);
			if (msg?.t === 'ack') finish();
		};
		client.connect();
	});
}
