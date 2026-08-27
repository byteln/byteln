/** Session crypto: AES-256-GCM with key in URL fragment only. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

export type PlainMessage = {
	v: 1;
	ts: number;
	type: 'text';
	body: string;
};

export async function encryptMessage(key: CryptoKey, msg: PlainMessage): Promise<ArrayBuffer> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = encoder.encode(JSON.stringify(msg));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
	const out = new Uint8Array(1 + iv.length + ct.byteLength);
	out[0] = 1; // wire version
	out.set(iv, 1);
	out.set(new Uint8Array(ct), 1 + iv.length);
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
	const parsed = JSON.parse(decoder.decode(pt)) as PlainMessage;
	if (parsed.v !== 1 || parsed.type !== 'text' || typeof parsed.body !== 'string') {
		throw new Error('invalid message schema');
	}
	return parsed;
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
