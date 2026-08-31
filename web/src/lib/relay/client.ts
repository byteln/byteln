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

		const ws = new WebSocket(this.url);
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

	/** Close and wait for the relay to release the seat (like a page refresh). */
	closeAndWait(timeoutMs = 2500): Promise<void> {
		this.autoReconnect = false;
		this.clearReconnectTimer();
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
