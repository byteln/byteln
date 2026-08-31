/** App session PIN vault — encrypts room credentials at rest (local only). */

import { bytesToBase64Url, base64UrlToBytes } from './session';

const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 210_000;
const VAULT_META_KEY = 'vaultMeta';

export type RoomCredentials = {
	roomHash: string;
	roomPin: string | null;
	legacyToken?: string;
};

export type EncryptedBlob = {
	nonce: string;
	ciphertext: string;
};

export type VaultMeta = {
	version: 1;
	salt: string;
	verifier: string;
	deviceSessionId?: string;
};

let vaultKey: CryptoKey | null = null;
let deviceSessionId: string | null = null;

export function isVaultUnlocked(): boolean {
	return vaultKey !== null;
}

export function lockVault(): void {
	vaultKey = null;
	deviceSessionId = null;
}

export function getDeviceSessionId(): string | null {
	return deviceSessionId;
}

function buf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out;
}

async function deriveVaultKey(pin: string, salt: Uint8Array): Promise<CryptoKey> {
	const passKey = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: buf(salt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		passKey,
		256
	);
	return crypto.subtle.importKey('raw', bits, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function deriveVerifier(pin: string, salt: Uint8Array): Promise<Uint8Array> {
	const passKey = await crypto.subtle.importKey('raw', encoder.encode(pin), 'PBKDF2', false, [
		'deriveBits'
	]);
	const verifySalt = new Uint8Array(salt.length + 8);
	verifySalt.set(salt, 0);
	verifySalt.set(encoder.encode('verifier'), salt.length);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', salt: buf(verifySalt), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
		passKey,
		256
	);
	return new Uint8Array(bits);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

async function getMetaFromDb(
	getter: (key: string) => Promise<{ key: string; value: string } | undefined>
): Promise<VaultMeta | null> {
	const row = await getter(VAULT_META_KEY);
	if (!row) return null;
	try {
		return JSON.parse(row.value) as VaultMeta;
	} catch {
		return null;
	}
}

export async function hasVault(
	getMeta: () => Promise<VaultMeta | null> = () => getMetaFromDb(getMetaEntry)
): Promise<boolean> {
	return (await getMeta()) !== null;
}

import {
	getMetaEntry,
	setMetaEntry
} from '$lib/storage/history';

export async function createVault(pin: string): Promise<void> {
	if (!/^\d{4,8}$/.test(pin)) {
		throw new Error('App PIN must be 4–8 digits.');
	}
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const verifier = await deriveVerifier(pin, salt);
	const sid = crypto.randomUUID();
	const meta: VaultMeta = {
		version: 1,
		salt: bytesToBase64Url(salt),
		verifier: bytesToBase64Url(verifier),
		deviceSessionId: sid
	};
	await setMetaEntry(VAULT_META_KEY, JSON.stringify(meta));
	vaultKey = await deriveVaultKey(pin, salt);
	deviceSessionId = sid;
}

export async function unlockVault(pin: string): Promise<boolean> {
	const meta = await getMetaFromDb(getMetaEntry);
	if (!meta) {
		vaultKey = null;
		deviceSessionId = null;
		return true;
	}
	const salt = base64UrlToBytes(meta.salt);
	const expected = base64UrlToBytes(meta.verifier);
	const derived = await deriveVerifier(pin, salt);
	if (!constantTimeEqual(derived, expected)) {
		vaultKey = null;
		deviceSessionId = null;
		return false;
	}
	vaultKey = await deriveVaultKey(pin, salt);
	deviceSessionId = meta.deviceSessionId ?? null;
	if (!deviceSessionId) {
		deviceSessionId = crypto.randomUUID();
		const next: VaultMeta = { ...meta, deviceSessionId };
		await setMetaEntry(VAULT_META_KEY, JSON.stringify(next));
	}
	return true;
}

export async function encryptCredentials(creds: RoomCredentials): Promise<EncryptedBlob | undefined> {
	if (!vaultKey) return undefined;
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = encoder.encode(JSON.stringify(creds));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vaultKey, plaintext);
	return {
		nonce: bytesToBase64Url(iv),
		ciphertext: bytesToBase64Url(new Uint8Array(ct))
	};
}

export async function decryptCredentials(blob: EncryptedBlob): Promise<RoomCredentials | null> {
	if (!vaultKey) return null;
	return decryptCredentialsWithKey(blob, vaultKey);
}

async function decryptCredentialsWithKey(
	blob: EncryptedBlob,
	key: CryptoKey
): Promise<RoomCredentials | null> {
	try {
		const ivRaw = base64UrlToBytes(blob.nonce);
		const iv = new Uint8Array(ivRaw);
		const ctRaw = base64UrlToBytes(blob.ciphertext);
		const ct = new Uint8Array(ctRaw);
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
		return JSON.parse(new TextDecoder().decode(plain)) as RoomCredentials;
	} catch {
		return null;
	}
}

/** Decrypt saved room credentials with app PIN (without changing vault session). */
export async function decryptCredentialsWithPin(
	blob: EncryptedBlob,
	pin: string
): Promise<RoomCredentials | null> {
	const meta = await getMetaFromDb(getMetaEntry);
	if (!meta) return null;
	const salt = base64UrlToBytes(meta.salt);
	const expected = base64UrlToBytes(meta.verifier);
	const derived = await deriveVerifier(pin, salt);
	if (!constantTimeEqual(derived, expected)) return null;
	const key = await deriveVaultKey(pin, salt);
	return decryptCredentialsWithKey(blob, key);
}

/** Session-only credential cache when vault is not configured or not yet unlocked. */
const sessionCreds = new Map<string, RoomCredentials>();

export function stashSessionCredentials(bucketId: string, creds: RoomCredentials): void {
	sessionCreds.set(bucketId, creds);
}

export function takeSessionCredentials(bucketId: string): RoomCredentials | undefined {
	return sessionCreds.get(bucketId);
}

export function getSessionCredentials(bucketId: string): RoomCredentials | undefined {
	return sessionCreds.get(bucketId);
}

export function clearSessionCredentials(): void {
	sessionCreds.clear();
}

export function clearSessionCredentialsFor(bucketId: string): void {
	sessionCreds.delete(bucketId);
}
