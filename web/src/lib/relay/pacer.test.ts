import { describe, expect, it } from 'vitest';
import { Pacer } from './pacer';

describe('Pacer', () => {
	it('allows the burst immediately, then holds the sustained rate', async () => {
		let now = 0;
		const sleeps: number[] = [];
		const pacer = new Pacer(
			1000,
			2000,
			() => now,
			async (ms) => {
				sleeps.push(ms);
				now += ms;
			}
		);
		await pacer.take(1000);
		await pacer.take(1000);
		expect(now).toBe(0);
		await pacer.take(1000);
		expect(now).toBe(1000);
		await pacer.take(500);
		expect(now).toBe(1500);
		expect(sleeps.every((s) => s > 0)).toBe(true);
	});

	it('lets a frame larger than the burst through once the bucket is full', async () => {
		let now = 0;
		const pacer = new Pacer(
			1000,
			500,
			() => now,
			async (ms) => {
				now += ms;
			}
		);
		await pacer.take(800);
		await pacer.take(800);
		expect(now).toBeGreaterThanOrEqual(800);
	});
});
