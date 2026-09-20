/** Encrypted history export/import (HKDF backup key + optional passphrase). */

import {
	base64ToBytes,
	base64UrlToBytes,
	bytesToBase64,
	bytesToBase64Url,
	exportKeyRaw,
	type ImageMime,
	type PlainMessage,
	type ReplyRef
} from './session';

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

function parseReplyTo(raw: unknown): ReplyRef | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== 'string' || !r.id || typeof r.preview !== 'string') return undefined;
	return { id: r.id, preview: r.preview };
}

/** JSON-safe message for export ciphertext (image bytes as standard base64). */
type WireStoredMessage =
	| (Extract<PlainMessage, { type: 'text' }> & { id: string; from: 'self' | 'peer' })
	| {
			v: 1;
			ts: number;
			type: 'image';
			mime: ImageMime;
			dataB64: string;
			w?: number;
			h?: number;
			id: string;
			from: 'self' | 'peer';
			replyTo?: ReplyRef;
	  };

function toWire(msg: StoredMessage): WireStoredMessage {
	if (msg.type === 'image') {
		const w: WireStoredMessage = {
			v: 1,
			ts: msg.ts,
			type: 'image',
			mime: msg.mime,
			dataB64: bytesToBase64(msg.data),
			id: msg.id,
			from: msg.from
		};
		if (typeof msg.w === 'number') w.w = msg.w;
		if (typeof msg.h === 'number') w.h = msg.h;
		if (msg.replyTo) w.replyTo = msg.replyTo;
		return w;
	}
	const out: WireStoredMessage = {
		v: 1,
		ts: msg.ts,
		type: 'text',
		body: msg.body,
		id: msg.id,
		from: msg.from
	};
	if (msg.replyTo) out.replyTo = msg.replyTo;
	return out;
}

function fromWire(raw: unknown): StoredMessage | null {
	if (!raw || typeof raw !== 'object') return null;
	const m = raw as Record<string, unknown>;
	if (typeof m.id !== 'string' || (m.from !== 'self' && m.from !== 'peer')) return null;
	const replyTo = parseReplyTo(m.replyTo);
	if (m.type === 'image') {
		if (typeof m.ts !== 'number') return null;
		const mime = m.mime;
		if (
			mime !== 'image/jpeg' &&
			mime !== 'image/png' &&
			mime !== 'image/webp' &&
			mime !== 'image/gif'
		) {
			return null;
		}
		const b64 = typeof m.dataB64 === 'string' ? m.dataB64 : '';
		if (!b64) return null;
		const msg: StoredMessage = {
			v: 1,
			ts: m.ts,
			type: 'image',
			mime,
			data: base64ToBytes(b64),
			id: m.id,
			from: m.from
		};
		if (typeof m.w === 'number') msg.w = m.w;
		if (typeof m.h === 'number') msg.h = m.h;
		if (replyTo) msg.replyTo = replyTo;
		return msg;
	}
	if (m.type === 'text' && typeof m.body === 'string' && typeof m.ts === 'number') {
		const msg: StoredMessage = {
			v: 1,
			ts: m.ts,
			type: 'text',
			body: m.body,
			id: m.id,
			from: m.from
		};
		if (replyTo) msg.replyTo = replyTo;
		return msg;
	}
	return null;
}

function serializeMessages(messages: StoredMessage[]): string {
	return JSON.stringify({ messages: messages.map(toWire) });
}

function parseMessagesPayload(pt: ArrayBuffer): StoredMessage[] {
	const parsed = JSON.parse(decoder.decode(pt)) as { messages?: unknown };
	if (!Array.isArray(parsed.messages)) throw new Error('bad payload');
	const out: StoredMessage[] = [];
	for (const item of parsed.messages) {
		const m = fromWire(item);
		if (m) out.push(m);
	}
	return out;
}

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
	const plaintext = encoder.encode(serializeMessages(messages));
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
		return { bucketId: file.bucket_id, messages: parseMessagesPayload(pt) };
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
	const plaintext = encoder.encode(serializeMessages(messages));
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
