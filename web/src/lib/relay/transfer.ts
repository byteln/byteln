/**
 * Reliable image/file transfer over the relay.
 *
 * The relay is lossy (it drops frames under backpressure and evicts its offline
 * buffer), so the sender keeps a bounded window of unacknowledged chunks, the
 * receiver acks what it holds, and only missing chunks are resent. Every chunk
 * carries the full header and the assembled payload must match its SHA-256.
 */

import type { StoredMessage } from '$lib/crypto/backup';
import {
	MAX_TRANSFER_BYTES,
	TRANSFER_CHUNK_BYTES,
	sha256Base64Url,
	transferChunkCount,
	type ImageMime,
	type PlainMessage,
	type ReplyRef,
	type TransferAckPlainMessage,
	type TransferCancelPlainMessage,
	type TransferChunkPlainMessage,
	type TransferHeader,
	type TransferKind
} from '$lib/crypto/session';

export type TransferStatus = 'active' | 'waiting' | 'failed';

export type Transfer = {
	id: string;
	direction: 'send' | 'recv';
	kind: TransferKind;
	/** 0..1 — for sends, the share the peer has confirmed. */
	progress: number;
	status: TransferStatus;
	detail?: string;
	mime: string;
	name?: string;
	size: number;
	w?: number;
	h?: number;
	from: 'self' | 'peer';
	replyTo?: ReplyRef;
	ts: number;
};

export type OutgoingPayload = {
	id: string;
	kind: TransferKind;
	ts: number;
	mime: string;
	data: Uint8Array;
	name?: string;
	w?: number;
	h?: number;
	replyTo?: ReplyRef;
};

export type TransferDeps = {
	/** Encrypt + pace + send; false when the socket is not usable. */
	send(bucketId: string, msg: PlainMessage): Promise<boolean>;
	/** Connected and the peer is believed online. */
	canSend(bucketId: string): boolean;
	hasMessage(bucketId: string, id: string): boolean;
	/** Persist + show a fully received, verified message. */
	deliver(bucketId: string, msg: StoredMessage): Promise<void>;
	publish(bucketId: string, transfers: Transfer[]): void;
	persistPending(bucketId: string, ids: string[]): void;
	/** Sender: the peer confirmed the whole payload. */
	onDelivered?(bucketId: string, id: string): void;
	hasStorageFor?(bytes: number): Promise<boolean>;
	now?(): number;
};

export type TransferLimits = {
	/** Max unacknowledged chunks in flight per transfer (keeps relay queues short). */
	window: number;
	/** Receiver acks after this many new chunks. */
	ackEvery: number;
	/** Base silence before asking for missing chunks; backs off per attempt. */
	stallMs: number;
	maxAttempts: number;
	maxIncomingPerRoom: number;
	maxIncomingBytesPerRoom: number;
	maxOutgoingPerRoom: number;
	/** Failed incoming transfers are dropped from memory after this long. */
	failedTtlMs: number;
	tickMs: number;
};

export const DEFAULT_TRANSFER_LIMITS: TransferLimits = {
	window: 12,
	ackEvery: 4,
	stallMs: 5_000,
	maxAttempts: 6,
	maxIncomingPerRoom: 3,
	maxIncomingBytesPerRoom: 30 * 1024 * 1024,
	maxOutgoingPerRoom: 3,
	failedTtlMs: 10 * 60_000,
	tickMs: 1_000
};

type Outgoing = {
	bucketId: string;
	id: string;
	header: TransferHeader;
	data: Uint8Array;
	total: number;
	acked: Set<number>;
	queue: number[];
	/** Chunk index → when it was last sent. */
	inFlight: Map<number, number>;
	status: TransferStatus;
	detail?: string;
	attempts: number;
	lastActivityAt: number;
	pumping: boolean;
};

type Incoming = {
	bucketId: string;
	id: string;
	header: TransferHeader;
	total: number;
	parts: (Uint8Array | null)[];
	received: number;
	status: TransferStatus;
	detail?: string;
	attempts: number;
	lastActivityAt: number;
	sinceAck: number;
	completing: boolean;
};

const CANCEL_DETAIL: Record<string, string> = {
	busy: 'Partner is busy — retry later',
	storage: 'Partner is out of storage',
	corrupt: 'File arrived corrupted',
	unavailable: 'Sender no longer has this file'
};

function range(n: number): number[] {
	return Array.from({ length: n }, (_, i) => i);
}

function sameHeader(a: TransferHeader, b: TransferHeader): boolean {
	return (
		a.kind === b.kind &&
		a.size === b.size &&
		a.sha256 === b.sha256 &&
		a.mime === b.mime &&
		a.ts === b.ts
	);
}

/** Magic-byte check so a mislabeled payload is never rendered as an image. */
export function matchesImageMime(mime: string, data: Uint8Array): boolean {
	const b = data;
	switch (mime) {
		case 'image/jpeg':
			return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
		case 'image/png':
			return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
		case 'image/gif':
			return b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
		case 'image/webp':
			return (
				b.length >= 12 &&
				b[0] === 0x52 &&
				b[1] === 0x49 &&
				b[2] === 0x46 &&
				b[3] === 0x46 &&
				b[8] === 0x57 &&
				b[9] === 0x45 &&
				b[10] === 0x42 &&
				b[11] === 0x50
			);
		default:
			return false;
	}
}

export class TransferEngine {
	private out = new Map<string, Map<string, Outgoing>>();
	private inc = new Map<string, Map<string, Incoming>>();
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly limits: TransferLimits;

	constructor(
		private deps: TransferDeps,
		limits: Partial<TransferLimits> = {}
	) {
		this.limits = { ...DEFAULT_TRANSFER_LIMITS, ...limits };
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	outgoingCount(bucketId: string): number {
		return this.out.get(bucketId)?.size ?? 0;
	}

	canStartSend(bucketId: string): boolean {
		return this.outgoingCount(bucketId) < this.limits.maxOutgoingPerRoom;
	}

	list(bucketId: string): Transfer[] {
		const items: Transfer[] = [];
		for (const o of this.out.get(bucketId)?.values() ?? []) {
			let bytes = 0;
			for (const i of o.acked) bytes += Math.min(TRANSFER_CHUNK_BYTES, o.header.size - i * TRANSFER_CHUNK_BYTES);
			items.push(this.view(o.id, 'send', o.header, o.status, o.detail, bytes, o.acked.size, o.total));
		}
		for (const i of this.inc.get(bucketId)?.values() ?? []) {
			let bytes = 0;
			for (const p of i.parts) if (p) bytes += p.byteLength;
			items.push(this.view(i.id, 'recv', i.header, i.status, i.detail, bytes, i.received, i.total));
		}
		return items;
	}

	private view(
		id: string,
		direction: Transfer['direction'],
		h: TransferHeader,
		status: TransferStatus,
		detail: string | undefined,
		bytes: number,
		count: number,
		total: number
	): Transfer {
		const progress = h.size > 0 ? Math.min(1, bytes / h.size) : count >= total ? 1 : 0;
		const t: Transfer = {
			id,
			direction,
			kind: h.kind,
			progress,
			status,
			mime: h.mime,
			size: h.size,
			from: direction === 'send' ? 'self' : 'peer',
			ts: h.ts
		};
		if (detail) t.detail = detail;
		if (h.name !== undefined) t.name = h.name;
		if (h.w !== undefined) t.w = h.w;
		if (h.h !== undefined) t.h = h.h;
		if (h.replyTo) t.replyTo = h.replyTo;
		return t;
	}

	private publish(bucketId: string) {
		this.deps.publish(bucketId, this.list(bucketId));
	}

	private persist(bucketId: string) {
		this.deps.persistPending(bucketId, [...(this.out.get(bucketId)?.keys() ?? [])]);
	}

	private ensureTimer() {
		if (this.timer || typeof setInterval === 'undefined') return;
		this.timer = setInterval(() => this.tick(), this.limits.tickMs);
	}

	private stopTimerIfIdle() {
		if (!this.timer) return;
		if (this.out.size === 0 && this.inc.size === 0) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private backoff(attempts: number): number {
		return this.limits.stallMs * Math.min(2 ** attempts, 6);
	}

	private isLiveOut(o: Outgoing): boolean {
		return this.out.get(o.bucketId)?.get(o.id) === o;
	}

	private isLiveIn(i: Incoming): boolean {
		return this.inc.get(i.bucketId)?.get(i.id) === i;
	}

	private deleteOut(o: Outgoing) {
		const map = this.out.get(o.bucketId);
		map?.delete(o.id);
		if (map && map.size === 0) this.out.delete(o.bucketId);
		this.persist(o.bucketId);
		this.stopTimerIfIdle();
	}

	private deleteIn(i: Incoming) {
		const map = this.inc.get(i.bucketId);
		map?.delete(i.id);
		if (map && map.size === 0) this.inc.delete(i.bucketId);
		this.stopTimerIfIdle();
	}

	private sendCtl(bucketId: string, msg: PlainMessage) {
		void this.deps.send(bucketId, msg).catch(() => false);
	}

	private sendAck(i: Incoming, opts: { resend?: boolean; done?: boolean } = {}) {
		const have: number[] = [];
		i.parts.forEach((p, idx) => {
			if (p) have.push(idx);
		});
		const ack: TransferAckPlainMessage = { v: 1, ts: this.now(), type: 'xfer_ack', id: i.id, have };
		if (opts.resend) ack.resend = true;
		if (opts.done) ack.done = true;
		this.sendCtl(i.bucketId, ack);
	}

	private sendCancel(bucketId: string, id: string, reason: string) {
		this.sendCtl(bucketId, { v: 1, ts: this.now(), type: 'xfer_cancel', id, reason });
	}

	private query(o: Outgoing) {
		o.lastActivityAt = this.now();
		if (!this.deps.canSend(o.bucketId)) {
			o.status = 'waiting';
			return;
		}
		this.sendCtl(o.bucketId, { v: 1, ts: this.now(), type: 'xfer_query', id: o.id });
	}

	// ── Sender ────────────────────────────────────────────────────────────

	/**
	 * Start (or with `resume`, re-offer after reload) an outgoing transfer.
	 * Resolves once queued; delivery continues in the background.
	 */
	async startSend(bucketId: string, payload: OutgoingPayload, opts: { resume?: boolean } = {}): Promise<void> {
		if (payload.data.byteLength > MAX_TRANSFER_BYTES) throw new Error('File too large (max 10 MB)');
		if (this.out.get(bucketId)?.has(payload.id)) return;
		const sha256 = await sha256Base64Url(payload.data);
		const header: TransferHeader = {
			kind: payload.kind,
			ts: payload.ts,
			mime: payload.mime,
			size: payload.data.byteLength,
			sha256
		};
		if (payload.name !== undefined) header.name = payload.name;
		if (payload.w !== undefined) header.w = payload.w;
		if (payload.h !== undefined) header.h = payload.h;
		if (payload.replyTo) header.replyTo = payload.replyTo;
		const total = transferChunkCount(header.size);
		const o: Outgoing = {
			bucketId,
			id: payload.id,
			header,
			data: payload.data,
			total,
			acked: new Set(),
			queue: opts.resume ? [] : range(total),
			inFlight: new Map(),
			status: 'active',
			attempts: 0,
			lastActivityAt: this.now(),
			pumping: false
		};
		let map = this.out.get(bucketId);
		if (!map) {
			map = new Map();
			this.out.set(bucketId, map);
		}
		map.set(o.id, o);
		this.persist(bucketId);
		this.ensureTimer();
		if (opts.resume) this.query(o);
		else void this.pump(o);
		this.publish(bucketId);
	}

	private chunk(o: Outgoing, index: number): TransferChunkPlainMessage {
		const start = index * TRANSFER_CHUNK_BYTES;
		return {
			v: 1,
			type: 'xfer_chunk',
			id: o.id,
			index,
			total: o.total,
			header: o.header,
			data: o.data.subarray(start, Math.min(start + TRANSFER_CHUNK_BYTES, o.header.size))
		};
	}

	private async pump(o: Outgoing): Promise<void> {
		if (o.pumping) return;
		o.pumping = true;
		try {
			while (
				o.status === 'active' &&
				this.isLiveOut(o) &&
				o.queue.length > 0 &&
				o.inFlight.size < this.limits.window
			) {
				const index = o.queue.shift()!;
				if (o.acked.has(index) || o.inFlight.has(index)) continue;
				if (!this.deps.canSend(o.bucketId)) {
					o.queue.unshift(index);
					o.status = 'waiting';
					break;
				}
				let ok = false;
				try {
					ok = await this.deps.send(o.bucketId, this.chunk(o, index));
				} catch {
					ok = false;
				}
				if (!this.isLiveOut(o)) return;
				if (!ok) {
					o.queue.unshift(index);
					o.status = 'waiting';
					break;
				}
				o.lastActivityAt = this.now();
				if (!o.acked.has(index)) o.inFlight.set(index, o.lastActivityAt);
			}
		} finally {
			o.pumping = false;
		}
		this.publish(o.bucketId);
	}

	handleAck(bucketId: string, ack: TransferAckPlainMessage) {
		const o = this.out.get(bucketId)?.get(ack.id);
		if (!o) {
			if (ack.resend && !ack.done) this.sendCancel(bucketId, ack.id, 'unavailable');
			return;
		}
		if (ack.done) {
			this.deleteOut(o);
			this.publish(bucketId);
			this.deps.onDelivered?.(bucketId, o.id);
			return;
		}
		const before = o.acked.size;
		for (const i of ack.have) {
			if (i >= o.total) continue;
			o.acked.add(i);
			o.inFlight.delete(i);
		}
		if (o.acked.size > before) o.attempts = 0;
		const now = this.now();
		o.lastActivityAt = now;
		if (ack.resend) {
			// Chunks sent moments ago are likely still in transit; don't duplicate them.
			for (const [i, sentAt] of o.inFlight) {
				if (now - sentAt >= this.limits.stallMs) o.inFlight.delete(i);
			}
			o.queue = range(o.total).filter((i) => !o.acked.has(i) && !o.inFlight.has(i));
			o.status = 'active';
			o.detail = undefined;
		}
		this.publish(bucketId);
		void this.pump(o);
	}

	handleCancel(bucketId: string, msg: TransferCancelPlainMessage) {
		const o = this.out.get(bucketId)?.get(msg.id);
		if (o) {
			o.status = 'failed';
			o.detail = CANCEL_DETAIL[msg.reason ?? ''] ?? 'Partner cancelled the transfer';
			o.inFlight.clear();
			o.queue = [];
		}
		const i = this.inc.get(bucketId)?.get(msg.id);
		if (i) this.deleteIn(i);
		if (o || i) this.publish(bucketId);
	}

	// ── Receiver ──────────────────────────────────────────────────────────

	handleQuery(bucketId: string, id: string) {
		const i = this.inc.get(bucketId)?.get(id);
		if (i) {
			if (i.completing) return;
			i.attempts = 0;
			i.status = 'active';
			i.detail = undefined;
			i.lastActivityAt = this.now();
			this.sendAck(i, { resend: true });
			this.publish(bucketId);
			return;
		}
		const ack: TransferAckPlainMessage = { v: 1, ts: this.now(), type: 'xfer_ack', id, have: [] };
		if (this.deps.hasMessage(bucketId, id)) ack.done = true;
		else ack.resend = true;
		this.sendCtl(bucketId, ack);
	}

	async handleChunk(bucketId: string, c: TransferChunkPlainMessage): Promise<void> {
		let map = this.inc.get(bucketId);
		let i = map?.get(c.id);
		if (!i) {
			if (this.out.get(bucketId)?.has(c.id)) return;
			if (this.deps.hasMessage(bucketId, c.id)) {
				this.sendCtl(bucketId, {
					v: 1,
					ts: this.now(),
					type: 'xfer_ack',
					id: c.id,
					have: [],
					done: true
				});
				return;
			}
			const pending = [...(map?.values() ?? [])];
			const pendingBytes = pending.reduce((s, x) => s + x.header.size, 0);
			if (
				pending.length >= this.limits.maxIncomingPerRoom ||
				pendingBytes + c.header.size > this.limits.maxIncomingBytesPerRoom
			) {
				this.sendCancel(bucketId, c.id, 'busy');
				return;
			}
			i = {
				bucketId,
				id: c.id,
				header: c.header,
				total: c.total,
				parts: Array.from({ length: c.total }, () => null),
				received: 0,
				status: 'active',
				attempts: 0,
				lastActivityAt: this.now(),
				sinceAck: 0,
				completing: false
			};
			if (!map) {
				map = new Map();
				this.inc.set(bucketId, map);
			}
			map.set(c.id, i);
			this.ensureTimer();
			if (this.deps.hasStorageFor) {
				const created = i;
				void this.deps.hasStorageFor(c.header.size).then((ok) => {
					if (ok || !this.isLiveIn(created)) return;
					this.deleteIn(created);
					this.sendCancel(bucketId, created.id, 'storage');
					this.publish(bucketId);
				});
			}
		} else if (!sameHeader(i.header, c.header) || i.total !== c.total) {
			return;
		}

		if (i.completing || i.parts[c.index]) return;
		i.parts[c.index] = c.data;
		i.received++;
		i.sinceAck++;
		i.attempts = 0;
		i.status = 'active';
		i.detail = undefined;
		i.lastActivityAt = this.now();

		if (i.received === i.total) {
			await this.complete(i);
			return;
		}
		if (i.sinceAck >= this.limits.ackEvery) {
			i.sinceAck = 0;
			this.sendAck(i);
		}
		this.publish(bucketId);
	}

	private async complete(i: Incoming): Promise<void> {
		i.completing = true;
		const data = new Uint8Array(i.header.size);
		let offset = 0;
		for (const p of i.parts) {
			if (!p) {
				i.completing = false;
				return;
			}
			data.set(p, offset);
			offset += p.byteLength;
		}
		const sha = await sha256Base64Url(data);
		if (!this.isLiveIn(i)) return;
		if (offset !== i.header.size || sha !== i.header.sha256) {
			i.attempts++;
			i.parts.fill(null);
			i.received = 0;
			i.sinceAck = 0;
			i.completing = false;
			if (i.attempts > 2) {
				this.deleteIn(i);
				this.sendCancel(i.bucketId, i.id, 'corrupt');
			} else {
				i.lastActivityAt = this.now();
				this.sendAck(i, { resend: true });
			}
			this.publish(i.bucketId);
			return;
		}

		try {
			await this.deps.deliver(i.bucketId, this.toStored(i, data));
		} catch (e) {
			console.warn('byteln: could not save received transfer', e);
			i.parts.fill(null);
			i.received = 0;
			i.completing = false;
			i.status = 'failed';
			i.detail = 'Could not save — storage may be full';
			i.lastActivityAt = this.now();
			this.publish(i.bucketId);
			return;
		}
		this.deleteIn(i);
		this.sendAck(i, { done: true });
		this.publish(i.bucketId);
	}

	private toStored(i: Incoming, data: Uint8Array): StoredMessage {
		const h = i.header;
		if (h.kind === 'image' && matchesImageMime(h.mime, data)) {
			const msg: StoredMessage = {
				v: 1,
				ts: h.ts,
				type: 'image',
				mime: h.mime as ImageMime,
				data,
				id: i.id,
				from: 'peer'
			};
			if (h.w !== undefined) msg.w = h.w;
			if (h.h !== undefined) msg.h = h.h;
			if (h.replyTo) msg.replyTo = h.replyTo;
			return msg;
		}
		const isImage = h.kind === 'image';
		const msg: StoredMessage = {
			v: 1,
			ts: h.ts,
			type: 'file',
			name: isImage ? 'attachment' : (h.name ?? 'file'),
			mime: isImage ? 'application/octet-stream' : h.mime,
			data,
			id: i.id,
			from: 'peer'
		};
		if (h.replyTo) msg.replyTo = h.replyTo;
		return msg;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────

	/** Socket open or peer (re)appeared: resume everything, including failed sends. */
	onConnected(bucketId: string) {
		for (const o of this.out.get(bucketId)?.values() ?? []) {
			o.attempts = 0;
			o.status = 'active';
			o.detail = undefined;
			o.inFlight.clear();
			this.query(o);
		}
		for (const i of this.inc.get(bucketId)?.values() ?? []) {
			if (i.completing) continue;
			i.attempts = 0;
			i.status = 'active';
			i.detail = undefined;
			i.lastActivityAt = this.now();
			if (this.deps.canSend(bucketId)) this.sendAck(i, { resend: true });
		}
		this.publish(bucketId);
	}

	onDisconnected(bucketId: string) {
		for (const o of this.out.get(bucketId)?.values() ?? []) {
			if (o.status === 'failed') continue;
			o.inFlight.clear();
			o.status = 'waiting';
		}
		for (const i of this.inc.get(bucketId)?.values() ?? []) {
			if (i.status !== 'failed') i.status = 'waiting';
		}
		this.publish(bucketId);
	}

	/** User-initiated retry from a failed bubble. */
	retry(bucketId: string, id: string) {
		const o = this.out.get(bucketId)?.get(id);
		if (o) {
			o.attempts = 0;
			o.status = 'active';
			o.detail = undefined;
			o.inFlight.clear();
			this.query(o);
		}
		const i = this.inc.get(bucketId)?.get(id);
		if (i && !i.completing) {
			i.attempts = 0;
			i.status = 'active';
			i.detail = undefined;
			i.lastActivityAt = this.now();
			this.sendAck(i, { resend: true });
		}
		this.ensureTimer();
		this.publish(bucketId);
	}

	/** Abort a transfer and tell the peer. */
	cancel(bucketId: string, id: string) {
		const o = this.out.get(bucketId)?.get(id);
		const i = this.inc.get(bucketId)?.get(id);
		if (o) this.deleteOut(o);
		if (i) this.deleteIn(i);
		if (o || i) {
			this.sendCancel(bucketId, id, 'cancelled');
			this.publish(bucketId);
		}
	}

	/** Drop local state for a message that was deleted (peer already told). */
	forget(bucketId: string, id: string) {
		const o = this.out.get(bucketId)?.get(id);
		const i = this.inc.get(bucketId)?.get(id);
		if (o) this.deleteOut(o);
		if (i) this.deleteIn(i);
		if (o || i) this.publish(bucketId);
	}

	/** Drop in-memory state; pending outgoing ids stay persisted unless `forgetPending`. */
	clearBucket(bucketId: string, opts: { forgetPending?: boolean } = {}) {
		this.out.delete(bucketId);
		this.inc.delete(bucketId);
		if (opts.forgetPending) this.deps.persistPending(bucketId, []);
		this.stopTimerIfIdle();
		this.deps.publish(bucketId, []);
	}

	clearAll() {
		this.out.clear();
		this.inc.clear();
		this.stopTimerIfIdle();
	}

	tick() {
		const now = this.now();
		const touched = new Set<string>();

		for (const map of this.out.values()) {
			for (const o of map.values()) {
				if (o.status === 'failed' || o.pumping) continue;
				if (o.status === 'waiting') {
					if (this.deps.canSend(o.bucketId)) {
						o.status = 'active';
						this.query(o);
						touched.add(o.bucketId);
					}
					continue;
				}
				if (o.queue.length > 0 && o.inFlight.size < this.limits.window) {
					void this.pump(o);
					continue;
				}
				// Window full or everything sent: waiting on acks / the final "done".
				if (now - o.lastActivityAt < this.backoff(o.attempts)) continue;
				o.attempts++;
				if (o.attempts > this.limits.maxAttempts) {
					o.status = 'failed';
					o.detail = 'Partner not responding';
					o.inFlight.clear();
				} else {
					this.query(o);
				}
				touched.add(o.bucketId);
			}
		}

		for (const map of this.inc.values()) {
			for (const i of [...map.values()]) {
				if (i.completing) continue;
				if (i.status === 'failed') {
					if (now - i.lastActivityAt > this.limits.failedTtlMs) {
						this.deleteIn(i);
						touched.add(i.bucketId);
					}
					continue;
				}
				if (now - i.lastActivityAt < this.backoff(i.attempts)) continue;
				i.lastActivityAt = now;
				if (!this.deps.canSend(i.bucketId)) {
					if (i.status !== 'waiting') {
						i.status = 'waiting';
						touched.add(i.bucketId);
					}
					continue;
				}
				i.attempts++;
				if (i.attempts > this.limits.maxAttempts) {
					i.status = 'failed';
					i.detail = 'Transfer stalled';
				} else {
					i.status = 'active';
					this.sendAck(i, { resend: true });
				}
				touched.add(i.bucketId);
			}
		}

		for (const bucketId of touched) this.publish(bucketId);
	}
}
