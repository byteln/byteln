/** Session crypto: AES-256-GCM with key in URL fragment only. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Max decoded image bytes after prepare (3 MiB). */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Client ciphertext ceiling — under relay 4 MiB MaxFrameBytes. */
export const MAX_CIPHERTEXT_BYTES = Math.floor(3.9 * 1024 * 1024);

const IMAGE_PLAIN_MARK = 0x02;

export async function generateSessionKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, [
		'encrypt',
		'decrypt'
	]);
}

export async function exportKeyRaw(key: CryptoKey): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function importKeyRaw(raw: Uint8Array): Promise<CryptoKey> {
	const copy = new Uint8Array(raw.byteLength);
	copy.set(raw);
	return crypto.subtle.importKey('raw', copy, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

export function keyToFragment(raw: Uint8Array): string {
	return bytesToBase64Url(raw);
}

export function keyFromFragment(frag: string): Uint8Array | null {
	const params = new URLSearchParams(frag.replace(/^#/, ''));
	const k = params.get('key');
	if (!k) return null;
	try {
		return base64UrlToBytes(k);
	} catch {
		return null;
	}
}

export type ImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

/** Shared reply target embedded in plaintext (preview for when parent is missing). */
export type ReplyRef = { id: string; preview: string };

const REPLY_PREVIEW_MAX = 80;

export type TextPlainMessage = {
	v: 1;
	ts: number;
	type: 'text';
	body: string;
	/** Shared across peers; optional when decoding legacy ciphertext. */
	id?: string;
	replyTo?: ReplyRef;
};

export type ImagePlainMessage = {
	v: 1;
	ts: number;
	type: 'image';
	mime: ImageMime;
	data: Uint8Array;
	w?: number;
	h?: number;
	/** Shared across peers; optional when decoding legacy ciphertext. */
	id?: string;
	replyTo?: ReplyRef;
};

export type PlainMessage = TextPlainMessage | ImagePlainMessage;

export function messagePreview(msg: PlainMessage): string {
	if (msg.type === 'image') return '[Image]';
	return msg.body;
}

/** Truncated preview for reply quotes / composer chip. */
export function replyPreview(msg: PlainMessage): string {
	const raw = messagePreview(msg);
	if (raw.length <= REPLY_PREVIEW_MAX) return raw;
	return raw.slice(0, REPLY_PREVIEW_MAX - 1) + '…';
}

function parseReplyTo(raw: unknown): ReplyRef | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== 'string' || !r.id || typeof r.preview !== 'string') return undefined;
	return { id: r.id, preview: r.preview };
}

function encodePlaintext(msg: PlainMessage): Uint8Array {
	if (!msg.id) throw new Error('message id required');
	if (msg.type === 'text') {
		const obj: Record<string, unknown> = {
			v: 1,
			ts: msg.ts,
			type: 'text',
			body: msg.body,
			id: msg.id
		};
		if (msg.replyTo) obj.replyTo = msg.replyTo;
		return encoder.encode(JSON.stringify(obj));
	}
	const metaObj: Record<string, unknown> = {
		v: 1,
		ts: msg.ts,
		type: 'image',
		mime: msg.mime,
		id: msg.id
	};
	if (typeof msg.w === 'number') metaObj.w = msg.w;
	if (typeof msg.h === 'number') metaObj.h = msg.h;
	if (msg.replyTo) metaObj.replyTo = msg.replyTo;
	const meta = encoder.encode(JSON.stringify(metaObj));
	if (meta.length > 0xffff) throw new Error('image meta too large');
	const out = new Uint8Array(1 + 2 + meta.length + msg.data.byteLength);
	out[0] = IMAGE_PLAIN_MARK;
	out[1] = (meta.length >> 8) & 0xff;
	out[2] = meta.length & 0xff;
	out.set(meta, 3);
	out.set(msg.data, 3 + meta.length);
	return out;
}

function isImageMime(m: unknown): m is ImageMime {
	return m === 'image/jpeg' || m === 'image/png' || m === 'image/webp' || m === 'image/gif';
}

function decodePlaintext(pt: Uint8Array): PlainMessage {
	if (pt.length === 0) throw new Error('invalid message schema');

	if (pt[0] === IMAGE_PLAIN_MARK) {
		if (pt.length < 3) throw new Error('invalid image envelope');
		const metaLen = ((pt[1]! << 8) | pt[2]!) >>> 0;
		if (pt.length < 3 + metaLen) throw new Error('invalid image envelope');
		const metaBytes = pt.subarray(3, 3 + metaLen);
		const data = pt.slice(3 + metaLen);
		let meta: {
			v?: unknown;
			ts?: unknown;
			type?: unknown;
			mime?: unknown;
			w?: unknown;
			h?: unknown;
			id?: unknown;
			replyTo?: unknown;
		};
		try {
			meta = JSON.parse(decoder.decode(metaBytes)) as typeof meta;
		} catch {
			throw new Error('invalid image meta');
		}
		if (meta.v !== 1 || meta.type !== 'image' || typeof meta.ts !== 'number' || !isImageMime(meta.mime)) {
			throw new Error('invalid message schema');
		}
		if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large');
		const msg: ImagePlainMessage = {
			v: 1,
			ts: meta.ts,
			type: 'image',
			mime: meta.mime,
			data
		};
		if (typeof meta.w === 'number') msg.w = meta.w;
		if (typeof meta.h === 'number') msg.h = meta.h;
		if (typeof meta.id === 'string' && meta.id) msg.id = meta.id;
		const replyTo = parseReplyTo(meta.replyTo);
		if (replyTo) msg.replyTo = replyTo;
		return msg;
	}

	const parsed = JSON.parse(decoder.decode(pt)) as {
		v?: unknown;
		ts?: unknown;
		type?: unknown;
		body?: unknown;
		id?: unknown;
		replyTo?: unknown;
	};
	if (
		parsed.v !== 1 ||
		parsed.type !== 'text' ||
		typeof parsed.ts !== 'number' ||
		typeof parsed.body !== 'string'
	) {
		throw new Error('invalid message schema');
	}
	const msg: TextPlainMessage = { v: 1, ts: parsed.ts, type: 'text', body: parsed.body };
	if (typeof parsed.id === 'string' && parsed.id) msg.id = parsed.id;
	const replyTo = parseReplyTo(parsed.replyTo);
	if (replyTo) msg.replyTo = replyTo;
	return msg;
}

function copyBytes(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out;
}

export async function encryptMessage(key: CryptoKey, msg: PlainMessage): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = copyBytes(encodePlaintext(msg));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	const out = new Uint8Array(1 + iv.length + ct.byteLength);
	out[0] = 1; // wire version
	out.set(iv, 1);
	out.set(new Uint8Array(ct), 1 + iv.length);
	if (out.byteLength > MAX_CIPHERTEXT_BYTES) {
		throw new Error('message too large for relay');
	}
	return out.buffer;
}

export async function decryptMessage(key: CryptoKey, buf: ArrayBuffer): Promise<PlainMessage> {
	const bytes = new Uint8Array(buf);
	if (bytes.length < 14 || bytes[0] !== 1) {
		throw new Error('unsupported ciphertext');
	}
	const iv = bytes.slice(1, 13);
	const ct = bytes.slice(13);
	const ivCopy = new Uint8Array(iv);
	const ctCopy = new Uint8Array(ct);
	const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivCopy }, key, ctCopy);
	return decodePlaintext(new Uint8Array(pt));
}

export function bytesToBase64Url(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
	const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

/** Standard base64 (for image export / data URLs). */
export function bytesToBase64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

export function base64ToBytes(s: string): Uint8Array {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function randomBucketId(len = 8): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let id = '';
	for (const b of bytes) id += alphabet[b % alphabet.length];
	return id;
}

export function randomToken(): string {
	return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}
