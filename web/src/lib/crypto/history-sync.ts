/** Room history digest + gzip pack for approved resync. */

import { fromWire, toWire, type StoredMessage } from './backup';
import { bytesToBase64Url } from './session';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function sortMessageIds(ids: string[]): string[] {
	return [...ids].sort();
}

export async function computeIdHash(ids: string[]): Promise<string> {
	const sorted = sortMessageIds(ids);
	const data = encoder.encode(sorted.join('\n'));
	const digest = await crypto.subtle.digest('SHA-256', data);
	return bytesToBase64Url(new Uint8Array(digest));
}

/** Stable fingerprint of this browser's device session (not the raw session id). */
export async function deviceFingerprint(sessionId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`byteln-device|${sessionId}`));
	return bytesToBase64Url(new Uint8Array(digest));
}

export function idsOnlyInA(a: string[], b: string[]): string[] {
	const setB = new Set(b);
	return a.filter((id) => !setB.has(id));
}

export function compareMessages(
	a: { id: string; ts: number },
	b: { id: string; ts: number }
): number {
	if (a.id < b.id) return -1;
	if (a.id > b.id) return 1;
	return a.ts - b.ts;
}

export function flipFrom(msg: StoredMessage): StoredMessage {
	return { ...msg, from: msg.from === 'self' ? 'peer' : 'self' };
}

export function filterMessagesByIds(messages: StoredMessage[], ids: string[]): StoredMessage[] {
	const want = new Set(ids);
	return messages.filter((m) => want.has(m.id));
}

async function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof CompressionStream === 'undefined') {
		throw new Error('CompressionStream unavailable');
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const stream = new Blob([copy]).stream().pipeThrough(new CompressionStream('gzip'));
	const ab = await new Response(stream).arrayBuffer();
	return new Uint8Array(ab);
}

async function gzipDecompress(bytes: Uint8Array): Promise<Uint8Array> {
	if (typeof DecompressionStream === 'undefined') {
		throw new Error('DecompressionStream unavailable');
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('gzip'));
	const ab = await new Response(stream).arrayBuffer();
	return new Uint8Array(ab);
}

/** Pack messages to gzip-compressed JSON (export wire shape). */
export async function packMessagesForSync(messages: StoredMessage[]): Promise<Uint8Array> {
	const json = JSON.stringify({ messages: messages.map(toWire) });
	return gzipCompress(encoder.encode(json));
}

/** Unpack gzip sync payload; flips from for the receiving peer. */
export async function unpackMessagesFromSync(compressed: Uint8Array): Promise<StoredMessage[]> {
	const pt = await gzipDecompress(compressed);
	const parsed = JSON.parse(decoder.decode(pt)) as { messages?: unknown };
	if (!Array.isArray(parsed.messages)) throw new Error('bad sync payload');
	const out: StoredMessage[] = [];
	for (const item of parsed.messages) {
		const m = fromWire(item);
		if (m) out.push(flipFrom(m));
	}
	return out;
}
