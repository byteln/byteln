/** Encrypted history export/import (HKDF backup key + optional passphrase). */

import { base64UrlToBytes, bytesToBase64Url, exportKeyRaw, type PlainMessage } from './session';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type StoredMessage = PlainMessage & { id: string; from: 'self' | 'peer' };

export type ExportFile = {
	version: 1;
	bucket_id: string;
	exported_at: string;
	nonce: string;
	ciphertext: string;
	/** Present when a passphrase was used (PBKDF2 salt). */
	pass_salt?: string;
};

function buf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(u8.byteLength);
	out.set(u8);
	return out;
}

async function deriveBackupKey(
	sessionKey: CryptoKey,
	passphrase?: string,
	passSalt?: Uint8Array
): Promise<{ key: CryptoKey; passSalt?: Uint8Array }> {
	const raw = await exportKeyRaw(sessionKey);
	const baseKey = await crypto.subtle.importKey('raw', buf(raw), 'HKDF', false, [
		'deriveBits',
		'deriveKey'
	]);

	let ikmBits = await crypto.subtle.deriveBits(
		{
			name: 'HKDF',
			hash: 'SHA-256',
			salt: encoder.encode('byteln-backup-v1'),
			info: encoder.encode('history-export')
		},
		baseKey,
		256
	);

	if (passphrase) {
		const salt = passSalt ? buf(passSalt) : crypto.getRandomValues(new Uint8Array(16));
		const passKey = await crypto.subtle.importKey(
			'raw',
			encoder.encode(passphrase),
			'PBKDF2',
			false,
			['deriveBits']
		);
		const passBits = await crypto.subtle.deriveBits(
			{ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
			passKey,
			256
		);
		const mixed = new Uint8Array(32);
		const a = new Uint8Array(ikmBits);
		const b = new Uint8Array(passBits);
		for (let i = 0; i < 32; i++) mixed[i] = a[i]! ^ b[i]!;
		ikmBits = mixed.buffer;
		const key = await crypto.subtle.importKey('raw', mixed, { name: 'AES-GCM' }, false, [
			'encrypt',
			'decrypt'
		]);
		return { key, passSalt: salt };
	}

	const key = await crypto.subtle.importKey('raw', ikmBits, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
	return { key };
}

export async function exportHistory(
	bucketId: string,
	sessionKey: CryptoKey,
	messages: StoredMessage[],
	passphrase?: string
): Promise<ExportFile> {
	const { key, passSalt } = await deriveBackupKey(sessionKey, passphrase);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = encoder.encode(JSON.stringify({ messages }));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
	const file: ExportFile = {
		version: 1,
		bucket_id: bucketId,
		exported_at: new Date().toISOString(),
		nonce: bytesToBase64Url(nonce),
		ciphertext: bytesToBase64Url(new Uint8Array(ct))
	};
	if (passSalt) file.pass_salt = bytesToBase64Url(passSalt);
	return file;
}

export async function importHistory(
	file: ExportFile,
	sessionKey: CryptoKey | null,
	passphrase?: string
): Promise<{ bucketId: string; messages: StoredMessage[] }> {
	if (file.version !== 1) throw new Error('unsupported export version');
	if (!sessionKey && !passphrase) {
		throw new Error('need session key or passphrase');
	}

	let key: CryptoKey;
	if (sessionKey) {
		const derived = await deriveBackupKey(
			sessionKey,
			passphrase,
			file.pass_salt ? base64UrlToBytes(file.pass_salt) : undefined
		);
		key = derived.key;
	} else {
		if (!file.pass_salt || !passphrase) {
			throw new Error('passphrase export required for keyless import');
		}
		const salt = buf(base64UrlToBytes(file.pass_salt));
		const passKey = await crypto.subtle.importKey(
			'raw',
			encoder.encode(passphrase),
			'PBKDF2',
			false,
			['deriveKey']
		);
		key = await crypto.subtle.deriveKey(
			{ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
			passKey,
			{ name: 'AES-GCM', length: 256 },
			false,
			['decrypt']
		);
	}

	const nonce = buf(base64UrlToBytes(file.nonce));
	const ct = buf(base64UrlToBytes(file.ciphertext));
	try {
		const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct);
		const parsed = JSON.parse(decoder.decode(pt)) as { messages: StoredMessage[] };
		if (!Array.isArray(parsed.messages)) throw new Error('bad payload');
		return { bucketId: file.bucket_id, messages: parsed.messages };
	} catch {
		throw new Error('decrypt failed — wrong key or passphrase');
	}
}

/**
 * Create an export decryptable with passphrase alone (for a device that never had the link).
 * Uses PBKDF2(passphrase) as the AES key; session key is not required for import.
 */
export async function exportHistoryWithPassphraseOnly(
	bucketId: string,
	messages: StoredMessage[],
	passphrase: string
): Promise<ExportFile> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const passKey = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
		'deriveKey'
	]);
	const key = await crypto.subtle.deriveKey(
		{ name: 'PBKDF2', salt, iterations: 210_000, hash: 'SHA-256' },
		passKey,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt']
	);
	const nonce = crypto.getRandomValues(new Uint8Array(12));
	const plaintext = encoder.encode(JSON.stringify({ messages }));
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plaintext);
	return {
		version: 1,
		bucket_id: bucketId,
		exported_at: new Date().toISOString(),
		nonce: bytesToBase64Url(nonce),
		ciphertext: bytesToBase64Url(new Uint8Array(ct)),
		pass_salt: bytesToBase64Url(salt)
	};
}
