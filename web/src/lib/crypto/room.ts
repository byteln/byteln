/** Room PIN gate + stable relay seat tokens (local only, never sent to server). */

import { base64UrlToBytes, bytesToBase64Url } from './session';

const encoder = new TextEncoder();

const PBKDF2_ITERATIONS = 210_000;

export type RoomFragment = {
	keyRaw: Uint8Array;
	pv: Uint8Array;
	salt: Uint8Array;
	seat: 0 | 1 | null;
	legacy: boolean;
};

function buf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out;
}

export function generateRoomPin(): string {
	const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
	return n.toString().padStart(6, '0');
}

export function generatePinSalt(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(16));
}

const B64URL_PARAM = /^[A-Za-z0-9_-]+/;

function cleanB64UrlParam(value: string): string {
	const m = value.trim().match(B64URL_PARAM);
	return m?.[0] ?? '';
}

/** Fix pasted links where PIN text got appended into the URL fragment. */
export function sanitizeRoomFragmentInput(hash: string): { hash: string; pinHint: string | null } {
	const raw = hash.replace(/^#/, '');
	const pinMatch = raw.match(/(?:Room\s*PIN|PIN)\s*:\s*(\d{6})/i);
	const pinHint = pinMatch?.[1] ?? null;

	const params = new URLSearchParams(raw);
	for (const name of ['key', 'pv', 'salt'] as const) {
		const v = params.get(name);
		if (!v) continue;
		const cleaned = cleanB64UrlParam(v);
		if (cleaned) params.set(name, cleaned);
		else params.delete(name);
	}
	const seat = params.get('seat');
	if (seat !== '0' && seat !== '1') params.delete('seat');

	if (!params.get('key')) return { hash, pinHint };
	return { hash: `#${params.toString()}`, pinHint };
}

export function parseRoomFragment(hash: string): RoomFragment | null {
	const { hash: clean } = sanitizeRoomFragmentInput(hash);
	const params = new URLSearchParams(clean.replace(/^#/, ''));
	const keyStr = params.get('key');
	if (!keyStr) return null;

	let keyRaw: Uint8Array;
	try {
		keyRaw = base64UrlToBytes(keyStr);
	} catch {
		return null;
	}

	const pvStr = params.get('pv');
	const saltStr = params.get('salt');
	if (!pvStr || !saltStr) {
		return { keyRaw, pv: new Uint8Array(), salt: new Uint8Array(), seat: null, legacy: true };
	}

	try {
		const pv = base64UrlToBytes(pvStr);
		const salt = base64UrlToBytes(saltStr);
		const seatParam = params.get('seat');
		let seat: 0 | 1 | null = null;
		if (seatParam === '0') seat = 0;
		else if (seatParam === '1') seat = 1;
		return { keyRaw, pv, salt, seat, legacy: false };
	} catch {
		return null;
	}
}

export function buildRoomHash(opts: {
	keyRaw: Uint8Array;
	pv: Uint8Array;
	salt: Uint8Array;
	seat?: 0 | 1;
}): string {
	const params = new URLSearchParams();
	params.set('key', bytesToBase64Url(opts.keyRaw));
	params.set('pv', bytesToBase64Url(opts.pv));
	params.set('salt', bytesToBase64Url(opts.salt));
	if (opts.seat !== undefined) params.set('seat', String(opts.seat));
	return `#${params.toString()}`;
}

/** Partner share link — same room, no host seat marker. */
export function shareRoomHash(hash: string): string {
	const params = new URLSearchParams(hash.replace(/^#/, ''));
	params.delete('seat');
	return `#${params.toString()}`;
}

export async function createPinVerifier(
	pin: string,
	salt: Uint8Array,
	bucketId: string
): Promise<Uint8Array> {
	const passKey = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
		'deriveBits'
	]);
	const saltInput = new Uint8Array(salt.length + encoder.encode(bucketId).length);
	saltInput.set(salt, 0);
	saltInput.set(encoder.encode(bucketId), salt.length);

	const bits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			salt: buf(saltInput),
			iterations: PBKDF2_ITERATIONS,
			hash: 'SHA-256'
		},
		passKey,
		256
	);
	return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
}

export async function verifyRoomPin(
	pin: string,
	salt: Uint8Array,
	bucketId: string,
	expected: Uint8Array
): Promise<boolean> {
	const derived = await createPinVerifier(pin, salt, bucketId);
	return constantTimeEqual(derived, expected);
}

export function resolveSeat(fragment: RoomFragment): 0 | 1 {
	if (fragment.seat === 0 || fragment.seat === 1) return fragment.seat;
	return 1;
}

export async function deriveRelayToken(
	keyRaw: Uint8Array,
	pin: string,
	bucketId: string,
	seat: 0 | 1
): Promise<string> {
	const hkdfKey = await crypto.subtle.importKey('raw', buf(keyRaw), 'HKDF', false, ['deriveBits']);
	const salt = encoder.encode(`byteln-relay|${pin}|${bucketId}|${seat}`);
	const info = encoder.encode('byteln-relay-v1');
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info },
		hkdfKey,
		128
	);
	return bytesToBase64Url(new Uint8Array(bits));
}

const PIN_ONCE_PREFIX = 'byteln:pin-once:';

export function stashCreatorPin(bucketId: string, pin: string): void {
	try {
		sessionStorage.setItem(`${PIN_ONCE_PREFIX}${bucketId}`, pin);
	} catch {
		/* private mode */
	}
}

export function takeCreatorPin(bucketId: string): string | null {
	try {
		const key = `${PIN_ONCE_PREFIX}${bucketId}`;
		const pin = sessionStorage.getItem(key);
		if (pin) sessionStorage.removeItem(key);
		return pin;
	} catch {
		return null;
	}
}
