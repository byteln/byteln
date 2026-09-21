import { describe, expect, it } from 'vitest';
import {
	IMAGE_CHUNK_PAYLOAD_BYTES,
	assembleImageChunks,
	decryptMessage,
	encryptMessage,
	generateSessionKey,
	splitImageChunks,
	type ImagePlainMessage
} from './session';

function makeImage(byteLength: number): ImagePlainMessage & { id: string } {
	const data = new Uint8Array(byteLength);
	for (let i = 0; i < byteLength; i++) data[i] = i & 0xff;
	return {
		v: 1,
		ts: 1_700_000_000_000,
		type: 'image',
		mime: 'image/jpeg',
		data,
		w: 640,
		h: 480,
		id: 'img-test-id',
		replyTo: { id: 'parent', preview: '[Image]' }
	};
}

describe('image chunk split/assemble', () => {
	it('always yields at least one chunk for empty payload', () => {
		const chunks = splitImageChunks(makeImage(0), 64);
		expect(chunks).toHaveLength(1);
		expect(chunks[0]!.index).toBe(0);
		expect(chunks[0]!.total).toBe(1);
		expect(chunks[0]!.byteLength).toBe(0);
		const assembled = assembleImageChunks(chunks);
		expect(assembled.data.byteLength).toBe(0);
		expect(assembled.id).toBe('img-test-id');
	});

	it('splits across chunk boundaries and reassembles identically', () => {
		const size = IMAGE_CHUNK_PAYLOAD_BYTES * 2 + 100;
		const original = makeImage(size);
		const chunks = splitImageChunks(original);
		expect(chunks).toHaveLength(3);
		expect(chunks[0]!.mime).toBe('image/jpeg');
		expect(chunks[0]!.byteLength).toBe(size);
		expect(chunks[0]!.replyTo?.id).toBe('parent');
		expect(chunks[1]!.mime).toBeUndefined();
		expect(chunks[2]!.data.byteLength).toBe(100);

		const assembled = assembleImageChunks(chunks);
		expect(assembled.data).toEqual(original.data);
		expect(assembled.w).toBe(640);
		expect(assembled.h).toBe(480);
		expect(assembled.replyTo).toEqual(original.replyTo);
	});

	it('encrypt/decrypt round-trips every chunk', async () => {
		const key = await generateSessionKey();
		const original = makeImage(IMAGE_CHUNK_PAYLOAD_BYTES + 17);
		const chunks = splitImageChunks(original, IMAGE_CHUNK_PAYLOAD_BYTES);
		const recovered = [];
		for (const chunk of chunks) {
			const buf = await encryptMessage(key, chunk);
			const plain = await decryptMessage(key, buf);
			expect(plain.type).toBe('image_chunk');
			if (plain.type !== 'image_chunk') throw new Error('expected chunk');
			recovered.push(plain);
		}
		const assembled = assembleImageChunks(recovered);
		expect(assembled.data).toEqual(original.data);
		expect(assembled.mime).toBe('image/jpeg');
	});

	it('still decrypts legacy single-frame images', async () => {
		const key = await generateSessionKey();
		const original = makeImage(128);
		const buf = await encryptMessage(key, original);
		const plain = await decryptMessage(key, buf);
		expect(plain.type).toBe('image');
		if (plain.type !== 'image') throw new Error('expected image');
		expect(plain.data).toEqual(original.data);
		expect(plain.id).toBe(original.id);
	});
});
