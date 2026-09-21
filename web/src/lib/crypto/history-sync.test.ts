import { describe, expect, it } from 'vitest';
import type { StoredMessage } from './backup';
import {
	compareMessages,
	computeIdHash,
	filterMessagesByIds,
	flipFrom,
	idsOnlyInA,
	packMessagesForSync,
	sortMessageIds,
	unpackMessagesFromSync
} from './history-sync';
import { uuidV7 } from './id';
import {
	assembleHistoryChunks,
	decryptMessage,
	encryptMessage,
	generateSessionKey,
	splitHistoryChunks
} from './session';

describe('uuidV7', () => {
	it('produces lexicographically sortable ids over time', async () => {
		const a = uuidV7(1_700_000_000_000);
		await new Promise((r) => setTimeout(r, 2));
		const b = uuidV7(1_700_000_000_050);
		expect(a < b).toBe(true);
		expect(a).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
		);
	});
});

describe('history digest and diff', () => {
	it('hashes sorted ids stably', async () => {
		const h1 = await computeIdHash(['b', 'a', 'c']);
		const h2 = await computeIdHash(['c', 'a', 'b']);
		expect(h1).toBe(h2);
		expect(sortMessageIds(['b', 'a'])).toEqual(['a', 'b']);
	});

	it('computes set differences', () => {
		expect(idsOnlyInA(['a', 'b', 'c'], ['b'])).toEqual(['a', 'c']);
		expect(idsOnlyInA(['a'], ['a', 'b'])).toEqual([]);
	});

	it('compareMessages sorts by id then ts', () => {
		expect(compareMessages({ id: 'a', ts: 2 }, { id: 'b', ts: 1 })).toBeLessThan(0);
		expect(compareMessages({ id: 'a', ts: 1 }, { id: 'a', ts: 2 })).toBeLessThan(0);
	});
});

describe('history sync pack', () => {
	const sample: StoredMessage[] = [
		{
			v: 1,
			ts: 100,
			type: 'text',
			body: 'hello',
			id: 'id-a',
			from: 'self'
		},
		{
			v: 1,
			ts: 200,
			type: 'image',
			mime: 'image/jpeg',
			data: new Uint8Array([1, 2, 3, 4]),
			id: 'id-b',
			from: 'peer',
			w: 10,
			h: 10
		}
	];

	it('gzip pack/unpack flips from', async () => {
		const packed = await packMessagesForSync(sample);
		expect(packed.byteLength).toBeGreaterThan(0);
		const out = await unpackMessagesFromSync(packed);
		expect(out).toHaveLength(2);
		expect(out[0]!.from).toBe('peer');
		expect(out[1]!.from).toBe('self');
		expect(out[0]!.type).toBe('text');
		if (out[1]!.type === 'image' && sample[1]!.type === 'image') {
			expect(out[1]!.data).toEqual(sample[1]!.data);
		}
	});

	it('filters by id set', () => {
		expect(filterMessagesByIds(sample, ['id-b']).map((m) => m.id)).toEqual(['id-b']);
	});

	it('flipFrom toggles', () => {
		expect(flipFrom(sample[0]!).from).toBe('peer');
	});

	it('history chunks round-trip through encrypt', async () => {
		const key = await generateSessionKey();
		const packed = await packMessagesForSync(sample);
		const chunks = splitHistoryChunks('req:requester', packed, 32);
		expect(chunks.length).toBeGreaterThan(1);
		const recovered = [];
		for (const c of chunks) {
			const buf = await encryptMessage(key, c);
			const plain = await decryptMessage(key, buf);
			expect(plain.type).toBe('history_chunk');
			if (plain.type === 'history_chunk') recovered.push(plain);
		}
		const assembled = assembleHistoryChunks(recovered);
		expect(assembled).toEqual(packed);
		const msgs = await unpackMessagesFromSync(assembled);
		expect(msgs).toHaveLength(2);
	});
});
