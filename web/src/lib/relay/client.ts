export type ControlHandler = (msg: { t: string; n?: number }) => void;
export type BinaryHandler = (data: ArrayBuffer) => void;
export type StatusHandler = (status: 'connecting' | 'open' | 'closed' | 'error', detail?: string) => void;

export class RelayClient {
	private ws: WebSocket | null = null;
	private url: string;
	onControl: ControlHandler | null = null;
	onBinary: BinaryHandler | null = null;
	onStatus: StatusHandler | null = null;

	constructor(relayBase: string, bucketId: string, token: string) {
		const base = relayBase.replace(/\/$/, '');
		const wsBase = base.startsWith('http')
			? base.replace(/^http/, 'ws')
			: base.startsWith('ws')
				? base
				: `ws://${base}`;
		this.url = `${wsBase}/bucket/${encodeURIComponent(bucketId)}?token=${encodeURIComponent(token)}`;
	}

	connect() {
		this.onStatus?.('connecting');
		const ws = new WebSocket(this.url);
		ws.binaryType = 'arraybuffer';
		this.ws = ws;
		ws.onopen = () => this.onStatus?.('open');
		ws.onerror = () => this.onStatus?.('error', 'socket error');
		ws.onclose = (ev) => {
			const detail = ev.code === 4001 ? 'bucket full' : `closed ${ev.code}`;
			this.onStatus?.('closed', detail);
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

	close() {
		this.ws?.close();
		this.ws = null;
	}
}
