/**
 * Client-side token bucket so bulk sends stay under the relay's per-connection
 * throughput cap (512 KiB/s, halved to 256 KiB/s once traffic looks like a
 * chunked transfer). Exceeding it makes the relay close the socket mid-transfer.
 */

/** Sustained rate, comfortably under the relay's tightened 256 KiB/s. */
export const PACER_BYTES_PER_SEC = 200 * 1024;
/** Max burst — two chunk frames, under the relay's tightened 512 KiB bucket. */
export const PACER_BURST_BYTES = 512 * 1024;

export class Pacer {
	private tokens: number;
	private last: number;
	private chain: Promise<void> = Promise.resolve();

	constructor(
		private rate = PACER_BYTES_PER_SEC,
		private burst = PACER_BURST_BYTES,
		private now: () => number = () => Date.now(),
		private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
	) {
		this.tokens = burst;
		this.last = now();
	}

	/** Resolves when `cost` bytes may be sent; callers are served in order. */
	take(cost: number): Promise<void> {
		const run = async () => {
			for (;;) {
				const t = this.now();
				this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
				this.last = t;
				// A frame larger than the burst is allowed once the bucket is full.
				if (this.tokens >= cost || this.tokens >= this.burst) {
					this.tokens -= cost;
					return;
				}
				await this.sleep(Math.ceil(((Math.min(cost, this.burst) - this.tokens) / this.rate) * 1000));
			}
		};
		const p = this.chain.then(run);
		this.chain = p.catch(() => {});
		return p;
	}
}
