/**
 * App-wide "working on it" indicator for operations that take a
 * perceptible-but-short amount of time and don't have a more specific inline
 * status of their own — e.g. solving the relay's proof-of-work challenge
 * (see $lib/relay/pow.ts) before a WebSocket connect.
 *
 * Reference-counted so overlapping callers (e.g. two rooms reconnecting at
 * once) don't hide it out from under each other.
 */
class GlobalLoaderStore {
	count = $state(0);
	message = $state('Working…');

	get visible() {
		return this.count > 0;
	}

	show(message = 'Working…') {
		this.count++;
		this.message = message;
	}

	hide() {
		if (this.count > 0) this.count--;
	}

	/** Shows the loader for the duration of `fn`, always hiding it after. */
	async wrap<T>(message: string, fn: () => Promise<T>): Promise<T> {
		this.show(message);
		try {
			return await fn();
		} finally {
			this.hide();
		}
	}
}

export const globalLoader = new GlobalLoaderStore();
