import { describe, expect, it } from 'vitest';
import { buildRoomHash } from '$lib/crypto/room';
import {
	createHandoffChannel,
	handoffUrl,
	openHandoff,
	parseHandoffFragment,
	parseHandoffScan,
	sealHandoff
} from './handoff';

const roomHash = buildRoomHash({
	keyRaw: new Uint8Array(32).fill(7),
	pv: new Uint8Array(32).fill(1),
	salt: new Uint8Array(16).fill(2),
	seat: 0
});

describe('handoff', () => {
	it('round-trips the channel through the QR url', () => {
		const ch = createHandoffChannel('wss://byteln.com');
		const parsed = parseHandoffScan(handoffUrl('https://byteln.com', ch));
		expect(parsed?.channelId).toBe(ch.channelId);
		expect(parsed?.relayUrl).toBe('wss://byteln.com');
		expect(Array.from(parsed?.keyRaw ?? [])).toEqual(Array.from(ch.keyRaw));
	});

	it('rejects foreign QR codes and bad fragments', () => {
		expect(parseHandoffScan('https://example.com/b/abc#key=x')).toBeNull();
		expect(parseHandoffScan('hello')).toBeNull();
		expect(parseHandoffFragment('#ch=ab&k=x&r=wss://a')).toBeNull();
		expect(parseHandoffFragment('#ch=abcdef&k=AAAA&r=https://a')).toBeNull();
	});

	it('seals a room and strips the host seat on open', async () => {
		const ch = createHandoffChannel('wss://byteln.com');
		const frame = await sealHandoff(ch, { t: 'room', bucketId: 'abcd1234', roomHash, pin: '123456' });
		const msg = await openHandoff(ch, frame);
		expect(msg).toMatchObject({ t: 'room', bucketId: 'abcd1234', pin: '123456' });
		expect(msg?.t === 'room' && msg.roomHash.includes('seat=')).toBe(false);
	});

	it('refuses frames from another channel or with a bad payload', async () => {
		const a = createHandoffChannel('wss://byteln.com');
		const b = createHandoffChannel('wss://byteln.com');
		const frame = await sealHandoff(a, { t: 'room', bucketId: 'abcd1234', roomHash, pin: '123456' });
		expect(await openHandoff(b, frame)).toBeNull();

		const bad = await sealHandoff(a, { t: 'room', bucketId: '../x', roomHash, pin: '123456' });
		expect(await openHandoff(a, bad)).toBeNull();
	});
});
