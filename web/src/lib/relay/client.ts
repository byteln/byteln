import { solvePowForConnect } from './pow';

export type ControlHandler = (msg: { t: string; n?: number }) => void;
export type BinaryHandler = (data: ArrayBuffer) => void;
export type StatusHandler = (
	status: 'connecting' | 'open' | 'closed' | 'error' | 'reconnecting',
	detail?: string
) => void;

export type RelayClientOptions = {
	autoReconnect?: boolean;
	maxReconnectDelayMs?: number;
};

export class RelayClient {
	private ws: WebSocket | null = null;
	private url: string;
	private intentionalClose = false;
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	// Bumped by every connect()/close() so a proof-of-work solve in flight
	// from a superseded connect() attempt can't open a stale socket after
	// the caller has already moved on (closed, or started a newer connect).
	private connectGeneration = 0;
	autoReconnect: boolean;
	private maxReconnectDelayMs: number;

	onControl: ControlHandler | null = null;
	onBinary: BinaryHandler | null = null;
	onStatus: StatusHandler | null = null;

	constructor(
		relayBase: string,
		bucketId: string,
		token: string,
		deviceSessionId: string,
		opts: RelayClientOptions = {}
	) {
		const base = relayBase.replace(/\/$/, '');
		const wsBase = base.startsWith('http')
			? base.replace(/^http/, 'ws')
			: base.startsWith('ws')
				? base
				: `ws://${base}`;
		const params = new URLSearchParams({ token });
		if (deviceSessionId) params.set('sid', deviceSessionId);
		this.url = `${wsBase}/bucket/${encodeURIComponent(bucketId)}?${params.toString()}`;
		this.autoReconnect = opts.autoReconnect ?? true;
		this.maxReconnectDelayMs = opts.maxReconnectDelayMs ?? 30_000;
	}

	connect() {
		this.clearReconnectTimer();
		if (this.ws) {
			this.intentionalClose = true;
			this.ws.close();
			this.ws = null;
			this.intentionalClose = false;
		}

		const isRetry = this.reconnectAttempt > 0;
		this.onStatus?.(isRetry ? 'reconnecting' : 'connecting');

		const generation = ++this.connectGeneration;
		void this.openSocket(generation);
	}

	/**
	 * Solves the relay's proof-of-work challenge (if it requires one — most
	 * don't, so this is normally a single cheap cached fetch) before opening
	 * the actual WebSocket. A rejected WS upgrade never surfaces its HTTP
	 * response body to page JS, so this has to happen up front rather than
	 * reactively after a failed connect.
	 */
	private async openSocket(generation: number) {
		let url = this.url;
		try {
			const pow = await solvePowForConnect(this.url);
			if (pow) {
				const u = new URL(this.url);
				u.searchParams.set('pow', pow);
				url = u.toString();
			}
		} catch {
			// Fall back to connecting without a solution; if one was
			// actually required the relay rejects the upgrade as usual and
			// this surfaces through the normal onerror/onclose path below.
		}

		// Superseded by a newer connect() or an explicit close() while the
		// challenge was being solved — don't open a socket nobody wants.
		if (generation !== this.connectGeneration) return;

		const ws = new WebSocket(url);
		ws.binaryType = 'arraybuffer';
		this.ws = ws;

		ws.onopen = () => {
			this.reconnectAttempt = 0;
			this.onStatus?.('open');
		};
		ws.onerror = () => this.onStatus?.('error', 'socket error');
		ws.onclose = (ev) => {
			this.ws = null;
			const detail = ev.code === 4001 ? 'bucket full' : `closed ${ev.code}`;
			this.onStatus?.('closed', detail);
			if (!this.intentionalClose && ev.code !== 4001 && this.autoReconnect) {
				this.scheduleReconnect();
			}
		};
		ws.onmessage = (ev) => {
			if (typeof ev.data === 'string') {
				try {
					const msg = JSON.parse(ev.data) as { t: string; n?: number };
					this.onControl?.(msg);
				} catch {
					/* ignore */
				}
				return;
			}
			if (ev.data instanceof ArrayBuffer) {
				this.onBinary?.(ev.data);
			}
		};
	}

	sendBinary(buf: ArrayBuffer) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(buf);
		}
	}

	sendControl(msg: { t: string; n?: number }) {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(msg));
		}
	}

	get connected() {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	/** Bytes queued in the browser send buffer (0 when drained / disconnected). */
	get bufferedAmount() {
		return this.ws?.bufferedAmount ?? 0;
	}

	/** Close and wait for the relay to release the seat (like a page refresh). */
	closeAndWait(timeoutMs = 2500): Promise<void> {
		this.autoReconnect = false;
		this.clearReconnectTimer();
		this.connectGeneration++;
		const ws = this.ws;
		if (!ws || ws.readyState === WebSocket.CLOSED) {
			this.intentionalClose = true;
			this.ws = null;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				this.intentionalClose = true;
				this.ws = null;
				resolve();
			};
			ws.addEventListener('close', () => finish(), { once: true });
			this.intentionalClose = true;
			ws.close();
			setTimeout(finish, timeoutMs);
		});
	}

	close() {
		this.autoReconnect = false;
		this.clearReconnectTimer();
		this.connectGeneration++;
		this.intentionalClose = true;
		this.ws?.close();
		this.ws = null;
	}

	private scheduleReconnect() {
		this.clearReconnectTimer();
		const delay = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxReconnectDelayMs);
		this.reconnectAttempt++;
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}

	private clearReconnectTimer() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
	}
}
