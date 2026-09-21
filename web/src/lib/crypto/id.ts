/** UUID version 7 — time-ordered, lexicographically sortable. */

let lastMs = -1;
let lastSeq = 0;

function bytesToUuid(bytes: Uint8Array): string {
	const hex: string[] = [];
	for (let i = 0; i < 16; i++) {
		hex.push(bytes[i]!.toString(16).padStart(2, '0'));
	}
	return (
		hex.slice(0, 4).join('') +
		'-' +
		hex.slice(4, 6).join('') +
		'-' +
		hex.slice(6, 8).join('') +
		'-' +
		hex.slice(8, 10).join('') +
		'-' +
		hex.slice(10, 16).join('')
	);
}

/**
 * Generate a UUID v7 (RFC 9562). Monotonic within the same millisecond via
 * a local sequence counter so consecutive ids remain sortable.
 */
export function uuidV7(now = Date.now()): string {
	let ms = now;
	if (ms === lastMs) {
		lastSeq = (lastSeq + 1) & 0xfff;
		if (lastSeq === 0) ms += 1;
	} else {
		lastMs = ms;
		lastSeq = Math.floor(Math.random() * 0x1000);
	}
	lastMs = ms;

	const bytes = new Uint8Array(16);
	const rand = crypto.getRandomValues(new Uint8Array(8));

	// 48-bit unix timestamp (ms)
	bytes[0] = (ms / 2 ** 40) & 0xff;
	bytes[1] = (ms / 2 ** 32) & 0xff;
	bytes[2] = (ms / 2 ** 24) & 0xff;
	bytes[3] = (ms / 2 ** 16) & 0xff;
	bytes[4] = (ms / 2 ** 8) & 0xff;
	bytes[5] = ms & 0xff;

	// version 7 + 12-bit rand_a (use monotonic seq)
	bytes[6] = 0x70 | ((lastSeq >> 8) & 0x0f);
	bytes[7] = lastSeq & 0xff;

	// variant 10xxxxxx + 62 bits random
	bytes[8] = 0x80 | (rand[0]! & 0x3f);
	bytes.set(rand.subarray(1, 8), 9);

	return bytesToUuid(bytes);
}
