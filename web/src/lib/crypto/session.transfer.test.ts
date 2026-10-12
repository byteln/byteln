import { describe, expect, it } from 'vitest';
import {
	decryptMessage,
	encryptMessage,
	generateSessionKey,
	MAX_TRANSFER_BYTES,
	sanitizeFileName,
	sha256Base64Url,
	TRANSFER_CHUNK_BYTES,
	transferChunkCount,
	type TransferChunkPlainMessage
} from './session';

async function chunk(over: Partial<TransferChunkPlainMessage> = {}): Promise<TransferChunkPlainMessage> {
	const data = new Uint8Array(100);
	return {
		v: 1,
		type: 'xfer_chunk',
		id: 'x1',
		index: 0,
		total: 1,
		header: {
			kind: 'file',
			ts: 1,
			mime: 'application/pdf',
			size: 100,
			sha256: await sha256Base64Url(data),
			name: 'report.pdf'
		},
		data,
		...over
	};
}

async function roundTrip(msg: TransferChunkPlainMessage) {
	const key = await generateSessionKey();
	return decryptMessage(key, await encryptMessage(key, msg));
}

describe('xfer_chunk wire format', () => {
	it('round-trips a chunk with its header', async () => {
		const out = await roundTrip(await chunk());
		expect(out.type).toBe('xfer_chunk');
		if (out.type !== 'xfer_chunk') throw new Error('expected chunk');
		expect(out.header.name).toBe('report.pdf');
		expect(out.data.byteLength).toBe(100);
	});

	it('rejects a declared size above 10 MiB', async () => {
		const c = await chunk();
		c.header = { ...c.header, size: MAX_TRANSFER_BYTES + 1 };
		c.total = transferChunkCount(MAX_TRANSFER_BYTES + 1);
		await expect(roundTrip(c)).rejects.toThrow();
	});

	it('rejects a chunk count that does not match the size', async () => {
		await expect(roundTrip(await chunk({ total: 5000 }))).rejects.toThrow();
	});

	it('rejects a chunk whose length is wrong for its index', async () => {
		const c = await chunk();
		c.header = { ...c.header, size: TRANSFER_CHUNK_BYTES + 10 };
		c.total = 2;
		c.data = new Uint8Array(50);
		await expect(roundTrip(c)).rejects.toThrow();
	});

	it('rejects a non-image mime for image transfers', async () => {
		const c = await chunk();
		c.header = { ...c.header, kind: 'image', mime: 'image/svg+xml' };
		await expect(roundTrip(c)).rejects.toThrow();
	});

	it('sanitizes the file name from the wire', async () => {
		const c = await chunk();
		c.header = { ...c.header, name: '../../etc/evil\u202Efdp.exe' };
		const out = await roundTrip(c);
		if (out.type !== 'xfer_chunk') throw new Error('expected chunk');
		expect(out.header.name).toBe('evilfdp.exe');
	});
});

describe('sanitizeFileName', () => {
	it('strips paths, control and bidi characters', () => {
		expect(sanitizeFileName('C:\\Users\\x\\a.txt')).toBe('a.txt');
		expect(sanitizeFileName('a\u0000b\u202E.txt')).toBe('ab.txt');
		expect(sanitizeFileName('...hidden')).toBe('hidden');
		expect(sanitizeFileName('')).toBe('file');
		expect(sanitizeFileName(42)).toBe('file');
		expect(sanitizeFileName('x'.repeat(500)).length).toBe(200);
	});
});
