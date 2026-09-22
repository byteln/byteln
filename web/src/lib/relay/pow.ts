/**
 * Client-side half of the relay's optional proof-of-work gate
 * (server/internal/relay/pow.go). Most self-hosted relays leave this
 * disabled (difficulty 0), so the common case is one cheap `required:false`
 * fetch, cached per relay origin so reconnects don't repeat it.
 *
 * A rejected WebSocket upgrade never exposes its HTTP response body to page
 * JS (browsers hide the handshake status entirely), so the client can't
 * discover the challenge reactively from a failed `new WebSocket(...)`. It
 * has to fetch GET {relay}/pow-challenge first and solve before connecting.
 */

const encoder = new TextEncoder();

export type PowChallengeInfo = {
	required: boolean;
	challenge?: string;
	difficulty?: number;
};

type CacheEntry = { info: PowChallengeInfo; expiresAt: number };

// Short cache so every reconnect attempt (auto-reconnect backs off but can
// still fire every few seconds) doesn't re-fetch the challenge endpoint for
// relays that don't need it — the overwhelmingly common case.
const NEGATIVE_CACHE_MS = 60_000;
const challengeCache = new Map<string, CacheEntry>();

function httpOriginFromWsUrl(wsUrl: string): string {
	const u = new URL(wsUrl);
	u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
	return u.origin;
}

/** Fetches (or returns a cached) pow requirement for the given relay. */
export async function getPowChallenge(wsUrl: string): Promise<PowChallengeInfo> {
	const origin = httpOriginFromWsUrl(wsUrl);
	const now = Date.now();
	const cached = challengeCache.get(origin);
	if (cached && cached.expiresAt > now) return cached.info;

	try {
		const resp = await fetch(`${origin}/pow-challenge`, { cache: 'no-store' });
		if (!resp.ok) {
			const info = { required: false };
			challengeCache.set(origin, { info, expiresAt: now + NEGATIVE_CACHE_MS });
			return info;
		}
		const data = (await resp.json()) as PowChallengeInfo;
		if (!data.required) {
			challengeCache.set(origin, {
				info: { required: false },
				expiresAt: now + NEGATIVE_CACHE_MS
			});
			return { required: false };
		}
		// Challenges are single-use-ish (short server TTL) — never cache a
		// "required: true" result, always fetch a fresh one when needed.
		return data;
	} catch {
		// Offline / relay unreachable: let the real WS connect attempt
		// surface the error as usual, don't cache a network failure.
		return { required: false };
	}
}

function leadingZeroBits(bytes: Uint8Array): number {
	let n = 0;
	for (const b of bytes) {
		if (b === 0) {
			n += 8;
			continue;
		}
		let byte = b;
		for (let bit = 0; bit < 8; bit++) {
			if ((byte & 0x80) !== 0) return n;
			n++;
			byte = (byte << 1) & 0xff;
		}
		return n;
	}
	return n;
}

/** Brute-forces a solution for `challenge` meeting `difficulty` leading zero bits. */
export async function solvePowChallenge(challenge: string, difficulty: number): Promise<string> {
	for (let i = 0; ; i++) {
		const solution = i.toString();
		const digest = await crypto.subtle.digest('SHA-256', encoder.encode(challenge + solution));
		if (leadingZeroBits(new Uint8Array(digest)) >= difficulty) {
			return solution;
		}
		// Yield to the event loop periodically so a slower device (or a
		// difficulty tuned higher than "instant") doesn't freeze the tab.
		if (i > 0 && i % 512 === 0) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
	}
}

/**
 * Returns the `pow=<challenge>:<solution>` query value to append to a WS
 * connect URL, or `null` if the relay doesn't require one. Safe to call on
 * every connect/reconnect attempt — cheap when disabled (the common case),
 * and never throws (falls back to `null` so the caller just tries the
 * connect and lets the relay's own error surface as usual).
 */
export async function solvePowForConnect(wsUrl: string): Promise<string | null> {
	const info = await getPowChallenge(wsUrl);
	if (!info.required || !info.challenge || !info.difficulty) return null;
	const solution = await solvePowChallenge(info.challenge, info.difficulty);
	return `${info.challenge}:${solution}`;
}
