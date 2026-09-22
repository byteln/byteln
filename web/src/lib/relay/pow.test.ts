import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPowChallenge, solvePowChallenge, solvePowForConnect } from './pow';

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe('solvePowChallenge', () => {
	it('finds a solution whose sha256 hash has enough leading zero bits', async () => {
		const solution = await solvePowChallenge('test-challenge', 8);
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode('test-challenge' + solution)
		);
		expect(new Uint8Array(digest)[0]).toBe(0);
	});

	it('accepts difficulty 0 immediately', async () => {
		const solution = await solvePowChallenge('anything', 0);
		expect(typeof solution).toBe('string');
	});

	// Regression: a difficulty misconfigured too high relative to the
	// server's challenge TTL must not hang forever — it should give up with
	// margin so the caller's fallback (connect without a solution, let the
	// relay reject it, retry on the next backoff) takes over instead of a
	// permanently-stuck "Verifying connection…" loader.
	it('gives up instead of looping forever on an unreachable difficulty', async () => {
		await expect(solvePowChallenge('anything', 256, 50)).rejects.toThrow(/timeout|difficulty/);
	});
});

describe('getPowChallenge / solvePowForConnect', () => {
	beforeEach(() => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ required: false })
			}))
		);
	});

	it('returns required:false when the relay reports no pow needed', async () => {
		const info = await getPowChallenge('ws://relay.example/bucket/abc?token=x');
		expect(info.required).toBe(false);
	});

	it('solvePowForConnect returns null when not required', async () => {
		const pow = await solvePowForConnect('ws://relay.example/bucket/abc?token=x');
		expect(pow).toBeNull();
	});

	it('caches a negative result per relay origin (single fetch across calls)', async () => {
		await getPowChallenge('ws://cache-test-relay.example/bucket/abc?token=x');
		await getPowChallenge('ws://cache-test-relay.example/bucket/def?token=y');
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it('solves and returns "challenge:solution" when required', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({
				ok: true,
				json: async () => ({ required: true, challenge: 'chal-abc', difficulty: 8 })
			}))
		);
		const pow = await solvePowForConnect('ws://other-relay.example/bucket/abc?token=x');
		expect(pow).not.toBeNull();
		const [challenge, solution] = pow!.split(':');
		expect(challenge).toBe('chal-abc');
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode('chal-abc' + solution)
		);
		expect(new Uint8Array(digest)[0]).toBe(0);
	});

	it('falls back to not-required when the fetch fails', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('network down');
			})
		);
		const pow = await solvePowForConnect('ws://unreachable-relay.example/bucket/abc?token=x');
		expect(pow).toBeNull();
	});
});
