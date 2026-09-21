/** Session crypto: AES-256-GCM with key in URL fragment only. */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Max decoded image bytes after prepare (3 MiB). */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
/** Client ciphertext ceiling — under relay 4 MiB MaxFrameBytes. */
export const MAX_CIPHERTEXT_BYTES = Math.floor(3.9 * 1024 * 1024);
/** Plaintext payload per image/history chunk frame (keeps count under relay MaxBufferFrames). */
export const IMAGE_CHUNK_PAYLOAD_BYTES = 256 * 1024;
/** Alias — history sync uses the same chunk size. */
export const HISTORY_CHUNK_PAYLOAD_BYTES = IMAGE_CHUNK_PAYLOAD_BYTES;

const IMAGE_PLAIN_MARK = 0x02;
const IMAGE_CHUNK_MARK = 0x03;
const HISTORY_CHUNK_MARK = 0x04;

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

/** Wire-only: remove message `id` on both peers; never stored in history. */
export type DeletePlainMessage = {
	v: 1;
	ts: number;
	type: 'delete';
	/** Id of the message to delete (same shared UUID as text/image). */
	id: string;
};

/** Wire-only chunk of an image transfer; never stored in history until assembled. */
export type ImageChunkPlainMessage = {
	v: 1;
	type: 'image_chunk';
	id: string;
	index: number;
	total: number;
	data: Uint8Array;
	/** Present on index 0. */
	ts?: number;
	mime?: ImageMime;
	byteLength?: number;
	w?: number;
	h?: number;
	replyTo?: ReplyRef;
};

/** Cheap history fingerprint exchanged on connect. */
export type HistoryDigestPlainMessage = {
	v: 1;
	ts: number;
	type: 'history_digest';
	count: number;
	idHash: string;
	/** SHA-256 of local device session id (base64url). */
	deviceFp?: string;
};

export type ResyncRequestPlainMessage = {
	v: 1;
	ts: number;
	type: 'resync_request';
	id: string;
	/** Requester device fingerprint for approver trust UI. */
	deviceFp?: string;
};

export type ResyncAcceptPlainMessage = {
	v: 1;
	ts: number;
	type: 'resync_accept';
	id: string;
	ids: string[];
};

export type ResyncRejectPlainMessage = {
	v: 1;
	ts: number;
	type: 'resync_reject';
	id: string;
	reason?: string;
};

export type ResyncIdsPlainMessage = {
	v: 1;
	ts: number;
	type: 'resync_ids';
	id: string;
	ids: string[];
};

/** Peer asks both sides to clear local history for this room. */
export type WipeHistoryPlainMessage = {
	v: 1;
	ts: number;
	type: 'wipe_history';
	id: string;
};

/** Wire-only chunk of a history sync transfer. */
export type HistoryChunkPlainMessage = {
	v: 1;
	type: 'history_chunk';
	/** Request id (resync session). */
	id: string;
	index: number;
	total: number;
	data: Uint8Array;
	/** Present on index 0 — full compressed blob length. */
	compressedLength?: number;
};

export type ContentPlainMessage = TextPlainMessage | ImagePlainMessage;
export type SyncControlPlainMessage =
	| HistoryDigestPlainMessage
	| ResyncRequestPlainMessage
	| ResyncAcceptPlainMessage
	| ResyncRejectPlainMessage
	| ResyncIdsPlainMessage
	| WipeHistoryPlainMessage;
export type PlainMessage =
	| ContentPlainMessage
	| DeletePlainMessage
	| ImageChunkPlainMessage
	| HistoryChunkPlainMessage
	| SyncControlPlainMessage;

export function messagePreview(msg: PlainMessage): string {
	if (msg.type === 'image' || msg.type === 'image_chunk') return '[Image]';
	if (
		msg.type === 'delete' ||
		msg.type === 'history_digest' ||
		msg.type === 'resync_request' ||
		msg.type === 'resync_accept' ||
		msg.type === 'resync_reject' ||
		msg.type === 'resync_ids' ||
		msg.type === 'history_chunk' ||
		msg.type === 'wipe_history'
	) {
		return '';
	}
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

function encodeBinaryEnvelope(mark: number, metaObj: Record<string, unknown>, payload: Uint8Array): Uint8Array {
	const meta = encoder.encode(JSON.stringify(metaObj));
	if (meta.length > 0xffff) throw new Error('image meta too large');
	const out = new Uint8Array(1 + 2 + meta.length + payload.byteLength);
	out[0] = mark;
	out[1] = (meta.length >> 8) & 0xff;
	out[2] = meta.length & 0xff;
	out.set(meta, 3);
	out.set(payload, 3 + meta.length);
	return out;
}

function encodePlaintext(msg: PlainMessage): Uint8Array {
	if (msg.type === 'history_digest') {
		const obj: Record<string, unknown> = {
			v: 1,
			ts: msg.ts,
			type: 'history_digest',
			count: msg.count,
			idHash: msg.idHash
		};
		if (msg.deviceFp) obj.deviceFp = msg.deviceFp;
		return encoder.encode(JSON.stringify(obj));
	}
	if (msg.type === 'resync_request') {
		if (!msg.id) throw new Error('message id required');
		const obj: Record<string, unknown> = {
			v: 1,
			ts: msg.ts,
			type: 'resync_request',
			id: msg.id
		};
		if (msg.deviceFp) obj.deviceFp = msg.deviceFp;
		return encoder.encode(JSON.stringify(obj));
	}
	if (msg.type === 'wipe_history') {
		if (!msg.id) throw new Error('message id required');
		return encoder.encode(
			JSON.stringify({ v: 1, ts: msg.ts, type: 'wipe_history', id: msg.id })
		);
	}
	if (msg.type === 'resync_reject') {
		if (!msg.id) throw new Error('message id required');
		const obj: Record<string, unknown> = {
			v: 1,
			ts: msg.ts,
			type: 'resync_reject',
			id: msg.id
		};
		if (msg.reason) obj.reason = msg.reason;
		return encoder.encode(JSON.stringify(obj));
	}
	if (msg.type === 'resync_accept' || msg.type === 'resync_ids') {
		if (!msg.id) throw new Error('message id required');
		return encoder.encode(
			JSON.stringify({
				v: 1,
				ts: msg.ts,
				type: msg.type,
				id: msg.id,
				ids: msg.ids
			})
		);
	}
	if (msg.type === 'history_chunk') {
		if (!msg.id) throw new Error('message id required');
		const metaObj: Record<string, unknown> = {
			v: 1,
			type: 'history_chunk',
			id: msg.id,
			index: msg.index,
			total: msg.total
		};
		if (msg.index === 0) {
			if (typeof msg.compressedLength !== 'number') {
				throw new Error('history chunk 0 meta incomplete');
			}
			metaObj.compressedLength = msg.compressedLength;
		}
		return encodeBinaryEnvelope(HISTORY_CHUNK_MARK, metaObj, msg.data);
	}
	if (!msg.id) throw new Error('message id required');
	if (msg.type === 'delete') {
		return encoder.encode(
			JSON.stringify({ v: 1, ts: msg.ts, type: 'delete', id: msg.id })
		);
	}
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
	if (msg.type === 'image_chunk') {
		const metaObj: Record<string, unknown> = {
			v: 1,
			type: 'image_chunk',
			id: msg.id,
			index: msg.index,
			total: msg.total
		};
		if (msg.index === 0) {
			if (typeof msg.ts !== 'number' || !isImageMime(msg.mime) || typeof msg.byteLength !== 'number') {
				throw new Error('image chunk 0 meta incomplete');
			}
			metaObj.ts = msg.ts;
			metaObj.mime = msg.mime;
			metaObj.byteLength = msg.byteLength;
			if (typeof msg.w === 'number') metaObj.w = msg.w;
			if (typeof msg.h === 'number') metaObj.h = msg.h;
			if (msg.replyTo) metaObj.replyTo = msg.replyTo;
		}
		return encodeBinaryEnvelope(IMAGE_CHUNK_MARK, metaObj, msg.data);
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
	return encodeBinaryEnvelope(IMAGE_PLAIN_MARK, metaObj, msg.data);
}

function isImageMime(m: unknown): m is ImageMime {
	return m === 'image/jpeg' || m === 'image/png' || m === 'image/webp' || m === 'image/gif';
}

function decodePlaintext(pt: Uint8Array): PlainMessage {
	if (pt.length === 0) throw new Error('invalid message schema');

	if (pt[0] === IMAGE_PLAIN_MARK || pt[0] === IMAGE_CHUNK_MARK || pt[0] === HISTORY_CHUNK_MARK) {
		if (pt.length < 3) throw new Error('invalid image envelope');
		const metaLen = ((pt[1]! << 8) | pt[2]!) >>> 0;
		if (pt.length < 3 + metaLen) throw new Error('invalid image envelope');
		const metaBytes = pt.subarray(3, 3 + metaLen);
		const data = pt.slice(3 + metaLen);
		let meta: Record<string, unknown>;
		try {
			meta = JSON.parse(decoder.decode(metaBytes)) as Record<string, unknown>;
		} catch {
			throw new Error('invalid image meta');
		}

		if (pt[0] === HISTORY_CHUNK_MARK) {
			if (
				meta.v !== 1 ||
				meta.type !== 'history_chunk' ||
				typeof meta.id !== 'string' ||
				!meta.id ||
				typeof meta.index !== 'number' ||
				typeof meta.total !== 'number' ||
				!Number.isInteger(meta.index) ||
				!Number.isInteger(meta.total) ||
				meta.index < 0 ||
				meta.total < 1 ||
				meta.index >= meta.total
			) {
				throw new Error('invalid message schema');
			}
			if (data.byteLength > HISTORY_CHUNK_PAYLOAD_BYTES) {
				throw new Error('history chunk too large');
			}
			const chunk: HistoryChunkPlainMessage = {
				v: 1,
				type: 'history_chunk',
				id: meta.id,
				index: meta.index,
				total: meta.total,
				data
			};
			if (meta.index === 0) {
				if (
					typeof meta.compressedLength !== 'number' ||
					!Number.isInteger(meta.compressedLength) ||
					meta.compressedLength < 0
				) {
					throw new Error('invalid message schema');
				}
				chunk.compressedLength = meta.compressedLength;
			}
			return chunk;
		}

		if (pt[0] === IMAGE_CHUNK_MARK) {
			if (
				meta.v !== 1 ||
				meta.type !== 'image_chunk' ||
				typeof meta.id !== 'string' ||
				!meta.id ||
				typeof meta.index !== 'number' ||
				typeof meta.total !== 'number' ||
				!Number.isInteger(meta.index) ||
				!Number.isInteger(meta.total) ||
				meta.index < 0 ||
				meta.total < 1 ||
				meta.index >= meta.total
			) {
				throw new Error('invalid message schema');
			}
			if (data.byteLength > IMAGE_CHUNK_PAYLOAD_BYTES) {
				throw new Error('image chunk too large');
			}
			const chunk: ImageChunkPlainMessage = {
				v: 1,
				type: 'image_chunk',
				id: meta.id,
				index: meta.index,
				total: meta.total,
				data
			};
			if (meta.index === 0) {
				if (
					typeof meta.ts !== 'number' ||
					!isImageMime(meta.mime) ||
					typeof meta.byteLength !== 'number' ||
					!Number.isInteger(meta.byteLength) ||
					meta.byteLength < 0 ||
					meta.byteLength > MAX_IMAGE_BYTES
				) {
					throw new Error('invalid message schema');
				}
				chunk.ts = meta.ts;
				chunk.mime = meta.mime;
				chunk.byteLength = meta.byteLength;
				if (typeof meta.w === 'number') chunk.w = meta.w;
				if (typeof meta.h === 'number') chunk.h = meta.h;
				const replyTo = parseReplyTo(meta.replyTo);
				if (replyTo) chunk.replyTo = replyTo;
			}
			return chunk;
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

	const parsed = JSON.parse(decoder.decode(pt)) as Record<string, unknown>;
	if (parsed.v !== 1 || typeof parsed.ts !== 'number') {
		throw new Error('invalid message schema');
	}
	if (parsed.type === 'history_digest') {
		if (typeof parsed.count !== 'number' || typeof parsed.idHash !== 'string' || !parsed.idHash) {
			throw new Error('invalid message schema');
		}
		const out: HistoryDigestPlainMessage = {
			v: 1,
			ts: parsed.ts,
			type: 'history_digest',
			count: parsed.count,
			idHash: parsed.idHash
		};
		if (typeof parsed.deviceFp === 'string' && parsed.deviceFp) out.deviceFp = parsed.deviceFp;
		return out;
	}
	if (parsed.type === 'resync_request') {
		if (typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid message schema');
		const out: ResyncRequestPlainMessage = {
			v: 1,
			ts: parsed.ts,
			type: 'resync_request',
			id: parsed.id
		};
		if (typeof parsed.deviceFp === 'string' && parsed.deviceFp) out.deviceFp = parsed.deviceFp;
		return out;
	}
	if (parsed.type === 'wipe_history') {
		if (typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid message schema');
		return { v: 1, ts: parsed.ts, type: 'wipe_history', id: parsed.id };
	}
	if (parsed.type === 'resync_reject') {
		if (typeof parsed.id !== 'string' || !parsed.id) throw new Error('invalid message schema');
		const out: ResyncRejectPlainMessage = {
			v: 1,
			ts: parsed.ts,
			type: 'resync_reject',
			id: parsed.id
		};
		if (typeof parsed.reason === 'string') out.reason = parsed.reason;
		return out;
	}
	if (parsed.type === 'resync_accept' || parsed.type === 'resync_ids') {
		if (typeof parsed.id !== 'string' || !parsed.id || !Array.isArray(parsed.ids)) {
			throw new Error('invalid message schema');
		}
		const ids = parsed.ids.filter((x): x is string => typeof x === 'string' && !!x);
		if (ids.length !== parsed.ids.length) throw new Error('invalid message schema');
		return {
			v: 1,
			ts: parsed.ts,
			type: parsed.type,
			id: parsed.id,
			ids
		};
	}
	if (parsed.type === 'delete') {
		if (typeof parsed.id !== 'string' || !parsed.id) {
			throw new Error('invalid message schema');
		}
		return { v: 1, ts: parsed.ts, type: 'delete', id: parsed.id };
	}
	if (parsed.type !== 'text' || typeof parsed.body !== 'string') {
		throw new Error('invalid message schema');
	}
	const msg: TextPlainMessage = { v: 1, ts: parsed.ts, type: 'text', body: parsed.body };
	if (typeof parsed.id === 'string' && parsed.id) msg.id = parsed.id;
	const replyTo = parseReplyTo(parsed.replyTo);
	if (replyTo) msg.replyTo = replyTo;
	return msg;
}

/** Split compressed history bytes into wire chunks (always ≥1 chunk). */
export function splitHistoryChunks(
	requestId: string,
	compressed: Uint8Array,
	chunkSize = HISTORY_CHUNK_PAYLOAD_BYTES
): HistoryChunkPlainMessage[] {
	if (chunkSize < 1) throw new Error('invalid chunk size');
	const total = Math.max(1, Math.ceil(compressed.byteLength / chunkSize) || 1);
	const chunks: HistoryChunkPlainMessage[] = [];
	for (let index = 0; index < total; index++) {
		const start = index * chunkSize;
		const end = Math.min(start + chunkSize, compressed.byteLength);
		const data = compressed.slice(start, end);
		const chunk: HistoryChunkPlainMessage = {
			v: 1,
			type: 'history_chunk',
			id: requestId,
			index,
			total,
			data
		};
		if (index === 0) chunk.compressedLength = compressed.byteLength;
		chunks.push(chunk);
	}
	return chunks;
}

/** Assemble history chunk payloads into the full compressed blob. */
export function assembleHistoryChunks(chunks: HistoryChunkPlainMessage[]): Uint8Array {
	if (chunks.length === 0) throw new Error('no chunks');
	const head = chunks.find((c) => c.index === 0);
	if (!head || typeof head.compressedLength !== 'number') {
		throw new Error('missing history chunk header');
	}
	const total = head.total;
	if (chunks.length !== total) throw new Error('incomplete chunks');
	const byIndex = new Map<number, HistoryChunkPlainMessage>();
	for (const c of chunks) {
		if (c.id !== head.id || c.total !== total) throw new Error('chunk mismatch');
		if (byIndex.has(c.index)) throw new Error('duplicate chunk');
		byIndex.set(c.index, c);
	}
	const out = new Uint8Array(head.compressedLength);
	let offset = 0;
	for (let i = 0; i < total; i++) {
		const c = byIndex.get(i);
		if (!c) throw new Error('missing chunk');
		if (offset + c.data.byteLength > head.compressedLength) throw new Error('chunk overflow');
		out.set(c.data, offset);
		offset += c.data.byteLength;
	}
	if (offset !== head.compressedLength) throw new Error('assembled size mismatch');
	return out;
}

/** Split a full image message into wire chunks (always ≥1 chunk). */
export function splitImageChunks(
	msg: ImagePlainMessage & { id: string },
	chunkSize = IMAGE_CHUNK_PAYLOAD_BYTES
): ImageChunkPlainMessage[] {
	if (chunkSize < 1) throw new Error('invalid chunk size');
	if (msg.data.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large');
	const total = Math.max(1, Math.ceil(msg.data.byteLength / chunkSize) || 1);
	const chunks: ImageChunkPlainMessage[] = [];
	for (let index = 0; index < total; index++) {
		const start = index * chunkSize;
		const end = Math.min(start + chunkSize, msg.data.byteLength);
		const data = msg.data.slice(start, end);
		const chunk: ImageChunkPlainMessage = {
			v: 1,
			type: 'image_chunk',
			id: msg.id,
			index,
			total,
			data
		};
		if (index === 0) {
			chunk.ts = msg.ts;
			chunk.mime = msg.mime;
			chunk.byteLength = msg.data.byteLength;
			if (typeof msg.w === 'number') chunk.w = msg.w;
			if (typeof msg.h === 'number') chunk.h = msg.h;
			if (msg.replyTo) chunk.replyTo = msg.replyTo;
		}
		chunks.push(chunk);
	}
	return chunks;
}

/** Assemble ordered chunk payloads into a stored image message. */
export function assembleImageChunks(chunks: ImageChunkPlainMessage[]): ImagePlainMessage & { id: string } {
	if (chunks.length === 0) throw new Error('no chunks');
	const head = chunks.find((c) => c.index === 0);
	if (!head || typeof head.ts !== 'number' || !isImageMime(head.mime) || typeof head.byteLength !== 'number') {
		throw new Error('missing image chunk header');
	}
	const total = head.total;
	if (chunks.length !== total) throw new Error('incomplete chunks');
	const byIndex = new Map<number, ImageChunkPlainMessage>();
	for (const c of chunks) {
		if (c.id !== head.id || c.total !== total) throw new Error('chunk mismatch');
		if (byIndex.has(c.index)) throw new Error('duplicate chunk');
		byIndex.set(c.index, c);
	}
	const out = new Uint8Array(head.byteLength);
	let offset = 0;
	for (let i = 0; i < total; i++) {
		const c = byIndex.get(i);
		if (!c) throw new Error('missing chunk');
		if (offset + c.data.byteLength > head.byteLength) throw new Error('chunk overflow');
		out.set(c.data, offset);
		offset += c.data.byteLength;
	}
	if (offset !== head.byteLength) throw new Error('assembled size mismatch');
	const msg: ImagePlainMessage & { id: string } = {
		v: 1,
		ts: head.ts,
		type: 'image',
		mime: head.mime,
		data: out,
		id: head.id
	};
	if (typeof head.w === 'number') msg.w = head.w;
	if (typeof head.h === 'number') msg.h = head.h;
	if (head.replyTo) msg.replyTo = head.replyTo;
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
