/** Prepare images for E2E send (≤3 MiB). GIFs pass through; other oversized images JPEG-recompress. */

import {
	MAX_IMAGE_BYTES,
	type ImageMime,
	type ImagePlainMessage
} from '$lib/crypto/session';

const ALLOWED: ReadonlySet<string> = new Set([
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif'
]);
const MAX_EDGE = 2560;

export type PreparedImage = Pick<ImagePlainMessage, 'mime' | 'data' | 'w' | 'h'>;

function asMime(m: string): ImageMime | null {
	if (m === 'image/jpeg' || m === 'image/png' || m === 'image/webp' || m === 'image/gif') {
		return m;
	}
	return null;
}

async function blobToUint8(blob: Blob): Promise<Uint8Array> {
	return new Uint8Array(await blob.arrayBuffer());
}

async function dimensionsOf(blob: Blob): Promise<{ w: number; h: number }> {
	const bmp = await createImageBitmap(blob);
	try {
		return { w: bmp.width, h: bmp.height };
	} finally {
		bmp.close();
	}
}

async function recompress(file: Blob): Promise<PreparedImage> {
	const bmp = await createImageBitmap(file);
	try {
		let { width, height } = bmp;
		const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
		width = Math.max(1, Math.round(width * scale));
		height = Math.max(1, Math.round(height * scale));

		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('canvas unavailable');
		ctx.drawImage(bmp, 0, 0, width, height);

		const qualities = [0.85, 0.72, 0.6, 0.48, 0.36];
		for (const q of qualities) {
			const blob = await new Promise<Blob | null>((resolve) =>
				canvas.toBlob((b) => resolve(b), 'image/jpeg', q)
			);
			if (!blob) continue;
			if (blob.size <= MAX_IMAGE_BYTES) {
				return {
					mime: 'image/jpeg',
					data: await blobToUint8(blob),
					w: width,
					h: height
				};
			}
		}
		throw new Error('image too large after compress');
	} finally {
		bmp.close();
	}
}

/**
 * Pass through jpeg/png/webp/gif under 3 MiB.
 * Oversized still images: resize + JPEG recompress. Oversized GIFs: reject (keeps animation).
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
	const rawMime = (file.type || '').toLowerCase();
	const mime = asMime(rawMime);

	if (mime && ALLOWED.has(mime) && file.size <= MAX_IMAGE_BYTES) {
		const data = await blobToUint8(file);
		if (data.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large');
		try {
			const { w, h } = await dimensionsOf(file);
			return { mime, data, w, h };
		} catch {
			return { mime, data };
		}
	}

	if (mime === 'image/gif' || rawMime === 'image/gif') {
		throw new Error('GIF too large (max 3 MiB)');
	}

	if (!rawMime.startsWith('image/') && !mime) {
		throw new Error('unsupported file type');
	}

	return recompress(file);
}
