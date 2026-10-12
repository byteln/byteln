import { describe, expect, it } from 'vitest';
import type { StoredMessage } from '$lib/crypto/backup';
import {
	decryptMessage,
	encryptMessage,
	generateSessionKey,
	TRANSFER_CHUNK_BYTES,
	type PlainMessage
} from '$lib/crypto/session';
import { TransferEngine, type Transfer, type TransferLimits } from './transfer';

const BUCKET = 'room1';

type Side = {
	engine: TransferEngine;
	delivered: StoredMessage[];
	transfers: Transfer[];
	pending: string[];
};

/**
 * Two engines joined by an encrypted, lossy in-memory "relay".
 * `drop(msg, n)` returns true to discard the n-th frame of that type.
 */
async function makePair(opts: {
	drop?: (from: 'a' | 'b', msg: PlainMessage) => boolean;
	limits?: Partial<TransferLimits>;
}) {
	const key = await generateSessionKey();
	let clock = 1_000_000;
	let inFlight = 0;
	let online = true;
	const sides: Record<'a' | 'b', Side> = {} as Record<'a' | 'b', Side>;

	const dispatch = async (to: Side, msg: PlainMessage) => {
		if (msg.type === 'xfer_chunk') await to.engine.handleChunk(BUCKET, msg);
		else if (msg.type === 'xfer_ack') to.engine.handleAck(BUCKET, msg);
		else if (msg.type === 'xfer_query') to.engine.handleQuery(BUCKET, msg.id);
		else if (msg.type === 'xfer_cancel') to.engine.handleCancel(BUCKET, msg);
	};

	for (const name of ['a', 'b'] as const) {
		const other = name === 'a' ? 'b' : 'a';
		const side: Side = { engine: null as unknown as TransferEngine, delivered: [], transfers: [], pending: [] };
		side.engine = new TransferEngine(
			{
				send: async (_bucket, msg) => {
					if (!online) return false;
					inFlight++;
					let buf: ArrayBuffer;
					try {
						buf = await encryptMessage(key, msg);
					} catch (e) {
						inFlight--;
						throw e;
					}
					if (opts.drop?.(name, msg)) {
						inFlight--;
						return true;
					}
					void (async () => {
						try {
							const plain = await decryptMessage(key, buf);
							await dispatch(sides[other], plain);
						} finally {
							inFlight--;
						}
					})();
					return true;
				},
				canSend: () => online,
				hasMessage: (_bucket, id) => side.delivered.some((m) => m.id === id),
				deliver: async (_bucket, msg) => {
					side.delivered.push(msg);
				},
				publish: (_bucket, list) => {
					side.transfers = list;
				},
				persistPending: (_bucket, ids) => {
					side.pending = ids;
				},
				now: () => clock
			},
			{ tickMs: 1e9, ...opts.limits }
		);
		sides[name] = side;
	}

	const yieldTask = () => new Promise((r) => setTimeout(r, 0));
	const settle = async () => {
		for (let i = 0; i < 2000; i++) {
			await yieldTask();
			if (inFlight === 0) {
				await yieldTask();
				if (inFlight === 0) return;
			}
		}
		throw new Error('channel did not settle');
	};

	/** Advance time and run both engines' stall detection until nothing moves. */
	const runUntilIdle = async (rounds = 40) => {
		for (let i = 0; i < rounds; i++) {
			await settle();
			clock += 30_000;
			sides.a.engine.tick();
			sides.b.engine.tick();
			await settle();
		}
	};

	return {
		a: sides.a,
		b: sides.b,
		settle,
		runUntilIdle,
		setOnline: (v: boolean) => {
			online = v;
		}
	};
}

function payload(size: number, seed = 7): Uint8Array {
	const data = new Uint8Array(size);
	for (let i = 0; i < size; i++) data[i] = (i * 31 + seed) & 0xff;
	return data;
}

function filePayload(id: string, data: Uint8Array) {
	return { id, kind: 'file' as const, ts: 1_700_000_000_000, mime: 'application/pdf', name: 'doc.pdf', data };
}

describe('TransferEngine', () => {
	it('delivers a multi-chunk file intact on a clean channel', async () => {
		const p = await makePair({});
		const data = payload(TRANSFER_CHUNK_BYTES * 3 + 123);
		await p.a.engine.startSend(BUCKET, filePayload('f1', data));
		await p.runUntilIdle(3);

		expect(p.b.delivered).toHaveLength(1);
		const got = p.b.delivered[0]!;
		expect(got.type).toBe('file');
		if (got.type !== 'file') throw new Error('expected file');
		expect(got.name).toBe('doc.pdf');
		expect(got.data).toEqual(data);
		expect(p.a.transfers).toHaveLength(0);
		expect(p.a.pending).toEqual([]);
		expect(p.b.transfers).toHaveLength(0);
	});

	it('resends only the missing chunks after drops', async () => {
		const dropped = new Set<number>();
		const sentCount = new Map<number, number>();
		const p = await makePair({
			drop: (from, msg) => {
				if (from !== 'a' || msg.type !== 'xfer_chunk') return false;
				sentCount.set(msg.index, (sentCount.get(msg.index) ?? 0) + 1);
				// Lose chunks 0 (carries nothing special now), 2 and 5 the first time only.
				if ([0, 2, 5].includes(msg.index) && !dropped.has(msg.index)) {
					dropped.add(msg.index);
					return true;
				}
				return false;
			}
		});
		const data = payload(TRANSFER_CHUNK_BYTES * 7 + 9);
		await p.a.engine.startSend(BUCKET, filePayload('f2', data));
		await p.runUntilIdle();

		expect(p.b.delivered).toHaveLength(1);
		const got = p.b.delivered[0]!;
		if (got.type !== 'file') throw new Error('expected file');
		expect(got.data).toEqual(data);
		for (const idx of [0, 2, 5]) expect(sentCount.get(idx)).toBe(2);
		for (const idx of [1, 3, 4, 6, 7]) expect(sentCount.get(idx)).toBe(1);
		expect(p.a.transfers).toHaveLength(0);
	});

	it('recovers when acks and the final done are lost', async () => {
		let doneDrops = 0;
		let ackDrops = 0;
		const p = await makePair({
			drop: (from, msg) => {
				if (from !== 'b' || msg.type !== 'xfer_ack') return false;
				if (msg.done && doneDrops++ === 0) return true;
				if (!msg.done && ackDrops++ < 2) return true;
				return false;
			}
		});
		const data = payload(TRANSFER_CHUNK_BYTES * 9);
		await p.a.engine.startSend(BUCKET, filePayload('f3', data));
		await p.runUntilIdle();

		expect(p.b.delivered).toHaveLength(1);
		expect(p.a.transfers).toHaveLength(0);
		expect(p.a.pending).toEqual([]);
	});

	it('pauses while offline and resumes on reconnect', async () => {
		const p = await makePair({});
		const data = payload(TRANSFER_CHUNK_BYTES * 4 + 1);
		p.setOnline(false);
		await p.a.engine.startSend(BUCKET, filePayload('f4', data));
		await p.settle();
		expect(p.a.transfers[0]?.status).toBe('waiting');
		expect(p.b.delivered).toHaveLength(0);

		p.setOnline(true);
		p.a.engine.onConnected(BUCKET);
		await p.runUntilIdle(5);
		expect(p.b.delivered).toHaveLength(1);
	});

	it('marks the send failed when the peer never answers, and Retry resumes it', async () => {
		let blackhole = true;
		const p = await makePair({ drop: () => blackhole });
		const data = payload(TRANSFER_CHUNK_BYTES + 5);
		await p.a.engine.startSend(BUCKET, filePayload('f5', data));
		await p.runUntilIdle(12);
		expect(p.a.transfers[0]?.status).toBe('failed');

		blackhole = false;
		p.a.engine.retry(BUCKET, 'f5');
		await p.runUntilIdle(5);
		expect(p.b.delivered).toHaveLength(1);
		expect(p.a.transfers).toHaveLength(0);
	});

	it('resumes after the sender reloads (query → full resend)', async () => {
		const p = await makePair({});
		const data = payload(TRANSFER_CHUNK_BYTES * 2 + 77);
		await p.a.engine.startSend(BUCKET, filePayload('f6', data), { resume: true });
		await p.runUntilIdle(5);
		expect(p.b.delivered).toHaveLength(1);
		const got = p.b.delivered[0]!;
		if (got.type !== 'file') throw new Error('expected file');
		expect(got.data).toEqual(data);
	});

	it('rejects incoming transfers beyond the per-room limit', async () => {
		const p = await makePair({
			limits: { maxIncomingPerRoom: 1 },
			drop: (from, msg) => from === 'a' && msg.type === 'xfer_chunk' && msg.id === 'big1' && msg.index > 0
		});
		await p.a.engine.startSend(BUCKET, filePayload('big1', payload(TRANSFER_CHUNK_BYTES * 3)));
		await p.settle();
		await p.a.engine.startSend(BUCKET, filePayload('big2', payload(TRANSFER_CHUNK_BYTES)));
		await p.settle();
		const second = p.a.transfers.find((t) => t.id === 'big2');
		expect(second?.status).toBe('failed');
		expect(second?.detail).toMatch(/busy/i);
	});

	it('stores a mislabeled image as a plain file', async () => {
		const p = await makePair({});
		await p.a.engine.startSend(BUCKET, {
			id: 'img1',
			kind: 'image',
			ts: 1,
			mime: 'image/png',
			data: new TextEncoder().encode('<script>alert(1)</script>')
		});
		await p.runUntilIdle(2);
		const got = p.b.delivered[0]!;
		expect(got.type).toBe('file');
		if (got.type !== 'file') throw new Error('expected file');
		expect(got.mime).toBe('application/octet-stream');
	});
});
