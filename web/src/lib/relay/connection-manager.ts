/** Background relay pool — one WebSocket per open room; UI tabs switch view only. */

import type { StoredMessage } from '$lib/crypto/backup';
import {
	decryptCredentials,
	encryptCredentials,
	getDeviceSessionId,
	getSessionCredentials,
	isVaultUnlocked,
	stashSessionCredentials,
	clearSessionCredentials,
	clearSessionCredentialsFor,
	decryptCredentialsWithPin,
	type RoomCredentials
} from '$lib/crypto/vault';
import {
	deriveRelayToken,
	parseRoomFragment,
	resolveSeat,
	verifyRoomPin,
	type RoomFragment
} from '$lib/crypto/room';
import { uuidV7 } from '$lib/crypto/id';
import {
	computeIdHash,
	deviceFingerprint,
	filterMessagesByIds,
	idsOnlyInA,
	packMessagesForSync,
	sortMessageIds,
	unpackMessagesFromSync
} from '$lib/crypto/history-sync';
import {
	decryptMessage,
	encryptMessage,
	importKeyRaw,
	messagePreview,
	randomToken,
	splitHistoryChunks,
	splitImageChunks,
	type HistoryChunkPlainMessage,
	type ImageChunkPlainMessage,
	type ImageMime,
	type ImagePlainMessage,
	type PlainMessage,
	type ReplyRef
} from '$lib/crypto/session';
import { prepareImage } from '$lib/media/image';
import {
	notifyPartnerJoined,
	notifyPartnerMessage
} from '$lib/notify';
import { RelayClient, type StatusHandler } from '$lib/relay/client';
import { bumpRooms } from '$lib/stores/conversations';
import {
	addMessage,
	defaultNickname,
	deleteMessage,
	getRoom,
	getSessionToken,
	deleteMessagesForBucket,
	listMessages,
	listRooms,
	markRead,
	markUnread,
	mergeMessages,
	partnerLabel,
	removeRoom,
	clearRoomSessionStorage,
	setSeatReleased,
	setLastPeerDeviceFp,
	setSessionToken,
	touchRoom,
	upsertRoom,
	type RoomRecord
} from '$lib/storage/history';
import { goto } from '$app/navigation';
import { get, writable } from 'svelte/store';

export type ConnState = 'idle' | 'connecting' | 'open' | 'closed' | 'error' | 'reconnecting';

export type RoomRuntime = {
	connState: ConnState;
	connDetail: string;
	peerPresent: boolean;
	slot: number | null;
	bucketFull: boolean;
	reconnectAttempt: number;
	reconnectStalled: boolean;
};

type InternalRoom = {
	client: RelayClient | null;
	key: CryptoKey;
	fragment: RoomFragment;
	roomPin: string | null;
	legacyToken: string | null;
	relayUrl: string;
	runtime: RoomRuntime;
};

export const browserOffline = writable(false);

const MAX_OPEN_ROOMS = 10;
const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 35_000;
const HEARTBEAT_TIMEOUT_MS = 70_000;

export const activeBucketId = writable<string | null>(null);
export const roomRuntimes = writable<Record<string, RoomRuntime>>({});
export const messagesByBucket = writable<Record<string, StoredMessage[]>>({});

export type ImageTransfer = {
	id: string;
	direction: 'send' | 'recv';
	progress: number;
	mime?: ImageMime;
	w?: number;
	h?: number;
	from: 'self' | 'peer';
	replyTo?: ReplyRef;
	ts: number;
};

export const imageTransfersByBucket = writable<Record<string, ImageTransfer[]>>({});

export type ResyncStatus = {
	phase: 'idle' | 'waiting' | 'transferring' | 'done' | 'error';
	progress: number;
	detail?: string;
	requestId?: string;
};

/** True when peer digest idHash differs from local. */
export const historyMismatchByBucket = writable<Record<string, boolean>>({});
/** Incoming resync request awaiting Approve/Deny. */
export type ResyncPrompt = {
	requestId: string;
	ts: number;
	deviceFp?: string;
	/** same = matches last peer; new = different fingerprint; unknown = first time / no fp */
	deviceTrust: 'same' | 'new' | 'unknown';
};

export const resyncPromptByBucket = writable<Record<string, ResyncPrompt | null>>({});
export const resyncStatusByBucket = writable<Record<string, ResyncStatus>>({});

const IMAGE_TRANSFER_TTL_MS = 2 * 60 * 1000;
const RESYNC_TTL_MS = 2 * 60 * 1000;
const BUFFERED_AMOUNT_LOW = 64 * 1024;
const DIGEST_DEBOUNCE_MS = 300;

type PendingImage = {
	id: string;
	total: number;
	byteLength: number;
	mime: ImageMime;
	ts: number;
	w?: number;
	h?: number;
	replyTo?: ReplyRef;
	parts: (Uint8Array | null)[];
	receivedBytes: number;
	updatedAt: number;
};

type PendingHistory = {
	requestId: string;
	total: number;
	compressedLength: number;
	parts: (Uint8Array | null)[];
	receivedBytes: number;
	updatedAt: number;
};

type ResyncSession = {
	requestId: string;
	role: 'requester' | 'approver';
	peerIds: string[] | null;
	myIdsSent: boolean;
	updatedAt: number;
};

class ConnectionManagerImpl {
	private rooms = new Map<string, InternalRoom>();
	private creds = new Map<string, RoomCredentials>();
	/** One connect flow per room — avoids duplicate WebSockets on refresh. */
	private openPromises = new Map<string, Promise<boolean>>();
	private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private reconnectAttempts = new Map<string, number>();
	private heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
	private heartbeatPending = new Map<string, ReturnType<typeof setTimeout>>();
	private suppressReconnect = new Set<string>();
	private appLocked = false;
	private lifecycleInitialized = false;
	/** In-flight receive reassembly keyed by bucket → message id. */
	private pendingImages = new Map<string, Map<string, PendingImage>>();
	private pendingHistory = new Map<string, PendingHistory>();
	private resyncSessions = new Map<string, ResyncSession>();
	private peerDigests = new Map<string, { count: number; idHash: string }>();
	/** Latest device fingerprint from peer digests (memory only until trusted). */
	private currentPeerDeviceFp = new Map<string, string>();
	private digestTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private expectedHistoryRecv = new Map<string, number>(); // requestId → missing count from peer

	constructor() {
		this.initLifecycleHooks();
	}

	private defaultRuntime(): RoomRuntime {
		return {
			connState: 'connecting',
			connDetail: '',
			peerPresent: false,
			slot: null,
			bucketFull: false,
			reconnectAttempt: 0,
			reconnectStalled: false
		};
	}

	private setTransfers(bucketId: string, transfers: ImageTransfer[]) {
		imageTransfersByBucket.update((m) => {
			if (transfers.length === 0) {
				const next = { ...m };
				delete next[bucketId];
				return next;
			}
			return { ...m, [bucketId]: transfers };
		});
	}

	private getTransfers(bucketId: string): ImageTransfer[] {
		return get(imageTransfersByBucket)[bucketId] ?? [];
	}

	private upsertTransfer(bucketId: string, transfer: ImageTransfer) {
		const prev = this.getTransfers(bucketId);
		const i = prev.findIndex((t) => t.id === transfer.id && t.direction === transfer.direction);
		const next =
			i >= 0 ? prev.map((t, idx) => (idx === i ? transfer : t)) : [...prev, transfer];
		this.setTransfers(bucketId, next);
	}

	private removeTransfer(bucketId: string, id: string, direction?: ImageTransfer['direction']) {
		const next = this.getTransfers(bucketId).filter(
			(t) => !(t.id === id && (direction === undefined || t.direction === direction))
		);
		this.setTransfers(bucketId, next);
	}

	private clearTransfersForBucket(bucketId: string) {
		this.pendingImages.delete(bucketId);
		const session = this.resyncSessions.get(bucketId);
		if (session) {
			this.pendingHistory.delete(`${session.requestId}:requester`);
			this.pendingHistory.delete(`${session.requestId}:approver`);
			this.expectedHistoryRecv.delete(session.requestId);
		}
		this.resyncSessions.delete(bucketId);
		this.peerDigests.delete(bucketId);
		this.currentPeerDeviceFp.delete(bucketId);
		const digTimer = this.digestTimers.get(bucketId);
		if (digTimer) {
			clearTimeout(digTimer);
			this.digestTimers.delete(bucketId);
		}
		this.setTransfers(bucketId, []);
		historyMismatchByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});
		resyncPromptByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});
		resyncStatusByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});
	}

	private sweepPendingImages(bucketId: string) {
		const map = this.pendingImages.get(bucketId);
		if (!map) return;
		const now = Date.now();
		for (const [id, pending] of map) {
			if (now - pending.updatedAt > IMAGE_TRANSFER_TTL_MS) {
				map.delete(id);
				this.removeTransfer(bucketId, id, 'recv');
			}
		}
		if (map.size === 0) this.pendingImages.delete(bucketId);
	}

	private async waitForBufferedAmountLow(client: RelayClient): Promise<boolean> {
		while (client.connected && client.bufferedAmount > BUFFERED_AMOUNT_LOW) {
			await new Promise((r) => setTimeout(r, 16));
		}
		return client.connected;
	}

	private initLifecycleHooks() {
		if (this.lifecycleInitialized || typeof window === 'undefined') return;
		this.lifecycleInitialized = true;
		browserOffline.set(!navigator.onLine);
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible') {
				this.ensureAllConnected();
			}
		});
		window.addEventListener('online', () => {
			browserOffline.set(false);
			this.ensureAllConnected();
		});
		window.addEventListener('offline', () => {
			browserOffline.set(true);
			for (const room of this.rooms.values()) {
				if (room.runtime.connState === 'open') {
					room.runtime.connDetail = 'offline';
				}
			}
			this.syncRuntimes();
		});
	}

	private ensureAllConnected() {
		if (this.appLocked) return;
		for (const [bucketId, room] of this.rooms) {
			if (room.runtime.bucketFull) continue;
			if (
				!room.client?.connected ||
				room.runtime.connState === 'closed' ||
				room.runtime.connState === 'error' ||
				room.runtime.reconnectStalled
			) {
				this.resetReconnectState(bucketId);
				void this.reconnectRoom(bucketId);
			} else if (room.runtime.connState === 'open') {
				this.sendHeartbeatPing(bucketId);
			}
		}
	}

	private resetReconnectState(bucketId: string) {
		this.cancelManagedReconnect(bucketId);
		this.reconnectAttempts.delete(bucketId);
		const room = this.rooms.get(bucketId);
		if (room) {
			room.runtime.reconnectAttempt = 0;
			room.runtime.reconnectStalled = false;
			this.syncRuntimes();
		}
	}

	private cancelManagedReconnect(bucketId: string) {
		const timer = this.reconnectTimers.get(bucketId);
		if (timer) {
			clearTimeout(timer);
			this.reconnectTimers.delete(bucketId);
		}
	}

	private cancelAllManagedReconnects() {
		for (const timer of this.reconnectTimers.values()) {
			clearTimeout(timer);
		}
		this.reconnectTimers.clear();
	}

	private markReconnectStalled(bucketId: string) {
		const room = this.rooms.get(bucketId);
		if (!room) return;
		room.runtime.connState = 'error';
		room.runtime.connDetail = 'reconnect manually';
		room.runtime.reconnectStalled = true;
		this.syncRuntimes();
	}

	private scheduleManagedReconnect(bucketId: string) {
		if (this.appLocked || this.suppressReconnect.has(bucketId)) return;
		const room = this.rooms.get(bucketId);
		if (!room || room.runtime.bucketFull || room.runtime.reconnectStalled) return;

		this.cancelManagedReconnect(bucketId);

		const attempt = this.reconnectAttempts.get(bucketId) ?? 0;
		if (attempt >= MAX_RECONNECT_ATTEMPTS) {
			this.markReconnectStalled(bucketId);
			return;
		}

		const delay = Math.min(1000 * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
		room.runtime.connState = 'reconnecting';
		room.runtime.reconnectAttempt = attempt + 1;
		room.runtime.reconnectStalled = false;
		room.runtime.connDetail = attempt > 0 ? `attempt ${attempt + 1}` : '';
		this.syncRuntimes();

		const timer = setTimeout(() => {
			this.reconnectTimers.delete(bucketId);
			if (!this.rooms.has(bucketId)) return;
			this.reconnectAttempts.set(bucketId, attempt + 1);
			void this.reconnectRoom(bucketId).then((ok) => {
				const r = this.rooms.get(bucketId);
				if (!r || ok || r.runtime.bucketFull) return;
				this.scheduleManagedReconnect(bucketId);
			});
		}, delay);
		this.reconnectTimers.set(bucketId, timer);
	}

	private stopHeartbeat(bucketId: string) {
		const interval = this.heartbeatTimers.get(bucketId);
		if (interval) {
			clearInterval(interval);
			this.heartbeatTimers.delete(bucketId);
		}
		const pending = this.heartbeatPending.get(bucketId);
		if (pending) {
			clearTimeout(pending);
			this.heartbeatPending.delete(bucketId);
		}
	}

	private stopAllHeartbeats() {
		for (const bucketId of [...this.heartbeatTimers.keys()]) {
			this.stopHeartbeat(bucketId);
		}
	}

	private startHeartbeat(bucketId: string) {
		this.stopHeartbeat(bucketId);
		const tick = () => {
			const room = this.rooms.get(bucketId);
			if (!room?.client?.connected || room.runtime.connState !== 'open') return;
			if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
			this.sendHeartbeatPing(bucketId);
		};
		const interval = setInterval(tick, HEARTBEAT_INTERVAL_MS);
		this.heartbeatTimers.set(bucketId, interval);
		setTimeout(tick, 5000);
	}

	private sendHeartbeatPing(bucketId: string) {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected) return;

		if (this.heartbeatPending.has(bucketId)) {
			void this.forceStaleReconnect(bucketId);
			return;
		}

		room.client.sendControl({ t: 'ping' });
		const timeout = setTimeout(() => {
			this.heartbeatPending.delete(bucketId);
			void this.forceStaleReconnect(bucketId);
		}, HEARTBEAT_TIMEOUT_MS);
		this.heartbeatPending.set(bucketId, timeout);
	}

	private onHeartbeatPong(bucketId: string) {
		const pending = this.heartbeatPending.get(bucketId);
		if (pending) {
			clearTimeout(pending);
			this.heartbeatPending.delete(bucketId);
		}
	}

	private async forceStaleReconnect(bucketId: string) {
		const room = this.rooms.get(bucketId);
		if (!room || room.runtime.bucketFull || this.suppressReconnect.has(bucketId)) return;
		this.stopHeartbeat(bucketId);
		await this.reconnectRoom(bucketId);
		const r = this.rooms.get(bucketId);
		if (r && !r.client?.connected && !r.runtime.bucketFull && !r.runtime.reconnectStalled) {
			this.scheduleManagedReconnect(bucketId);
		}
	}

	private handleDisconnectForReconnect(bucketId: string) {
		if (this.suppressReconnect.has(bucketId) || this.appLocked) return;
		const room = this.rooms.get(bucketId);
		if (!room || room.runtime.bucketFull) return;
		this.scheduleManagedReconnect(bucketId);
	}

	private syncRuntimes() {
		const out: Record<string, RoomRuntime> = {};
		for (const [id, r] of this.rooms) out[id] = { ...r.runtime };
		roomRuntimes.set(out);
	}

	private syncMessages(bucketId: string, messages: StoredMessage[]) {
		const byId = new Map<string, StoredMessage>();
		for (const m of messages) byId.set(m.id, m);
		const sorted = [...byId.values()].sort((a, b) => {
			if (a.id < b.id) return -1;
			if (a.id > b.id) return 1;
			return a.ts - b.ts;
		});
		messagesByBucket.update((m) => ({ ...m, [bucketId]: sorted }));
	}

	/** Append if id is new; returns whether it was inserted. */
	private appendMessage(bucketId: string, stored: StoredMessage): boolean {
		const prev = get(messagesByBucket)[bucketId] ?? [];
		if (prev.some((m) => m.id === stored.id)) {
			return false;
		}
		this.syncMessages(bucketId, [...prev, stored]);
		return true;
	}

	private setResyncStatus(bucketId: string, status: ResyncStatus) {
		resyncStatusByBucket.update((m) => ({ ...m, [bucketId]: status }));
	}

	private setHistoryMismatch(bucketId: string, mismatch: boolean) {
		historyMismatchByBucket.update((m) => {
			if (!mismatch) {
				const next = { ...m };
				delete next[bucketId];
				return next;
			}
			return { ...m, [bucketId]: true };
		});
	}

	private schedulePublishDigest(bucketId: string) {
		const prev = this.digestTimers.get(bucketId);
		if (prev) clearTimeout(prev);
		const timer = setTimeout(() => {
			this.digestTimers.delete(bucketId);
			void this.publishDigest(bucketId);
		}, DIGEST_DEBOUNCE_MS);
		this.digestTimers.set(bucketId, timer);
	}

	async publishDigest(bucketId: string): Promise<void> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected || !room.runtime.peerPresent) return;
		const msgs = get(messagesByBucket)[bucketId] ?? [];
		const ids = msgs.map((m) => m.id);
		const idHash = await computeIdHash(ids);
		const sid = getDeviceSessionId();
		const deviceFp = sid ? await deviceFingerprint(sid) : undefined;
		const plain: PlainMessage = {
			v: 1,
			ts: Date.now(),
			type: 'history_digest',
			count: ids.length,
			idHash
		};
		if (deviceFp) plain.deviceFp = deviceFp;
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		const peer = this.peerDigests.get(bucketId);
		if (peer) {
			this.setHistoryMismatch(bucketId, peer.idHash !== idHash);
		}
	}

	private async onPeerDigest(
		bucketId: string,
		digest: { count: number; idHash: string; deviceFp?: string }
	): Promise<void> {
		this.peerDigests.set(bucketId, { count: digest.count, idHash: digest.idHash });
		if (digest.deviceFp) {
			this.currentPeerDeviceFp.set(bucketId, digest.deviceFp);
		}
		const msgs = get(messagesByBucket)[bucketId] ?? [];
		const localHash = await computeIdHash(msgs.map((m) => m.id));
		this.setHistoryMismatch(bucketId, localHash !== digest.idHash);
	}

	private async trustPeerDeviceFp(bucketId: string, fp: string | undefined): Promise<void> {
		if (!fp) return;
		await setLastPeerDeviceFp(bucketId, fp);
	}

	getRuntime(bucketId: string): RoomRuntime | undefined {
		return this.rooms.get(bucketId)?.runtime;
	}

	getMessages(bucketId: string): StoredMessage[] {
		return get(messagesByBucket)[bucketId] ?? [];
	}

	async setActive(bucketId: string | null): Promise<void> {
		activeBucketId.set(bucketId);
		if (bucketId) {
			await markRead(bucketId);
			bumpRooms();
		}
	}

	private async resolveExistingCredentials(
		bucketId: string,
		existing: RoomRecord | null
	): Promise<RoomCredentials | undefined> {
		let creds = this.creds.get(bucketId) ?? getSessionCredentials(bucketId);
		if (!creds && existing?.credentialsEnc && isVaultUnlocked()) {
			creds = (await decryptCredentials(existing.credentialsEnc)) ?? undefined;
		}
		return creds;
	}

	async registerRoom(opts: {
		bucketId: string;
		roomHash: string;
		relayUrl: string;
		nickname?: string;
		roomPin?: string | null;
		legacy?: boolean;
		legacyToken?: string;
		isCreator?: boolean;
	}): Promise<void> {
		const existing = await getRoom(opts.bucketId);
		const fragment = parseRoomFragment(opts.roomHash);
		const isCreator = opts.isCreator ?? existing?.isCreator ?? fragment?.seat === 0;
		const prior = await this.resolveExistingCredentials(opts.bucketId, existing);
		const roomPin =
			opts.roomPin !== undefined && opts.roomPin !== null
				? opts.roomPin
				: (prior?.roomPin ?? null);
		const creds: RoomCredentials = {
			roomHash: opts.roomHash,
			roomPin,
			...(opts.legacyToken
				? { legacyToken: opts.legacyToken }
				: prior?.legacyToken
					? { legacyToken: prior.legacyToken }
					: {})
		};
		stashSessionCredentials(opts.bucketId, creds);
		this.creds.set(opts.bucketId, creds);

		let credentialsEnc = existing?.credentialsEnc;
		if (isVaultUnlocked()) {
			const enc = await encryptCredentials(creds);
			if (enc) credentialsEnc = enc;
		}

		await upsertRoom({
			bucketId: opts.bucketId,
			nickname: opts.nickname ?? existing?.nickname ?? defaultNickname(opts.bucketId),
			roomHash: opts.roomHash,
			relayUrl: opts.relayUrl,
			createdAt: existing?.createdAt ?? Date.now(),
			lastActiveAt: Date.now(),
			unread: existing?.unread ?? false,
			credentialsEnc,
			legacy: opts.legacy ?? existing?.legacy,
			isCreator: opts.isCreator !== undefined ? opts.isCreator : (existing?.isCreator ?? isCreator)
		});
		bumpRooms();
	}

	async openRoom(bucketId: string): Promise<boolean> {
		const inflight = this.openPromises.get(bucketId);
		if (inflight) return inflight;

		const rec = await getRoom(bucketId);
		if (rec?.seatReleased) return false;

		const existing = this.rooms.get(bucketId);
		if (existing?.client?.connected) return true;

		const promise = this.doOpenRoom(bucketId);
		this.openPromises.set(bucketId, promise);
		try {
			return await promise;
		} finally {
			this.openPromises.delete(bucketId);
		}
	}

	/** Drop socket and reconnect (lock/unlock, line full, manual retry). */
	async reconnectRoom(bucketId: string): Promise<boolean> {
		const inflight = this.openPromises.get(bucketId);
		if (inflight) return inflight;

		const rec = await getRoom(bucketId);
		if (rec?.seatReleased) return false;

		this.resetReconnectState(bucketId);
		const promise = this.doReconnectRoom(bucketId);
		this.openPromises.set(bucketId, promise);
		try {
			return await promise;
		} finally {
			this.openPromises.delete(bucketId);
		}
	}

	private async doReconnectRoom(bucketId: string): Promise<boolean> {
		this.suppressReconnect.add(bucketId);
		this.stopHeartbeat(bucketId);
		try {
			const room = this.rooms.get(bucketId);
			if (room) {
				room.runtime.bucketFull = false;
				room.runtime.reconnectStalled = false;
				if (room.client) {
					await room.client.closeAndWait();
					room.client = null;
				}
			}
			// Let the relay process Leave before we open a new socket.
			await new Promise((r) => setTimeout(r, 350));
			if (!this.rooms.has(bucketId)) {
				return this.openRoom(bucketId);
			}
			return this.connectRoom(bucketId);
		} finally {
			this.suppressReconnect.delete(bucketId);
		}
	}

	private async connectRoom(bucketId: string): Promise<boolean> {
		const existing = this.rooms.get(bucketId);
		if (!existing) return false;
		if (existing.client?.connected) return true;

		this.suppressReconnect.add(bucketId);
		this.stopHeartbeat(bucketId);
		try {
			existing.runtime.bucketFull = false;
			existing.runtime.connState = 'connecting';
			this.syncRuntimes();
			if (existing.client) {
				await existing.client.closeAndWait();
				existing.client = null;
			}
			const token = await this.relayTokenForRoom(bucketId, existing);
			if (!token) return false;
			return this.connectRelay(bucketId, token);
		} finally {
			this.suppressReconnect.delete(bucketId);
		}
	}

	private async doOpenRoom(bucketId: string): Promise<boolean> {
		const existing = this.rooms.get(bucketId);
		if (existing?.client?.connected) return true;

		if (existing) {
			this.suppressReconnect.add(bucketId);
			try {
				existing.runtime.bucketFull = false;
				existing.runtime.connState = 'connecting';
				this.syncRuntimes();
				if (existing.client) {
					await existing.client.closeAndWait();
					existing.client = null;
				}
				const token = await this.relayTokenForRoom(bucketId, existing);
				if (!token) return false;
				return this.connectRelay(bucketId, token);
			} finally {
				this.suppressReconnect.delete(bucketId);
			}
		}

		if (this.rooms.size >= MAX_OPEN_ROOMS) return false;

		let creds = this.creds.get(bucketId) ?? getSessionCredentials(bucketId);
		if (!creds) {
			const record = await getRoom(bucketId);
			if (!record) return false;
			if (record.credentialsEnc && isVaultUnlocked()) {
				creds = (await decryptCredentials(record.credentialsEnc)) ?? undefined;
			}
		}
		if (!creds) return false;

		const fragment = parseRoomFragment(creds.roomHash);
		if (!fragment) return false;

		const record = await getRoom(bucketId);
		const relayUrl = record?.relayUrl ?? '';
		if (!relayUrl) return false;

		const key = await importKeyRaw(fragment.keyRaw);
		let messages = await listMessages(bucketId);
		this.syncMessages(bucketId, messages);

		const runtime: RoomRuntime = {
			connState: 'connecting',
			connDetail: '',
			peerPresent: false,
			slot: null,
			bucketFull: false,
			reconnectAttempt: 0,
			reconnectStalled: false
		};

		const internal: InternalRoom = {
			client: null,
			key,
			fragment,
			roomPin: creds.roomPin,
			legacyToken: creds.legacyToken ?? null,
			relayUrl,
			runtime
		};
		if (messages.some((m) => m.from === 'peer')) {
			runtime.peerPresent = true;
		}
		this.rooms.set(bucketId, internal);
		this.creds.set(bucketId, creds);
		this.syncRuntimes();

		const token = await this.relayTokenForRoom(bucketId, internal);
		if (!token) return false;
		return this.connectRelay(bucketId, token);
	}

	private async relayTokenForRoom(bucketId: string, room: InternalRoom): Promise<string | null> {
		if (room.fragment.legacy) {
			let token = room.legacyToken ?? (await getSessionToken(bucketId));
			if (!token) {
				token = randomToken();
				await setSessionToken(bucketId, token);
				room.legacyToken = token;
			}
			return token;
		}
		if (!room.roomPin) return null;
		const record = await getRoom(bucketId);
		const seat: 0 | 1 = record?.isCreator === true ? 0 : 1;
		return deriveRelayToken(room.fragment.keyRaw, room.roomPin, bucketId, seat);
	}

	async connectWithPin(bucketId: string, pin: string, roomHash: string, relayUrl: string): Promise<boolean> {
		const fragment = parseRoomFragment(roomHash);
		if (!fragment || fragment.legacy) return false;

		const ok = await verifyRoomPin(pin, fragment.salt, bucketId, fragment.pv);
		if (!ok) return false;

		const existing = await getRoom(bucketId);
		const fromFragment = resolveSeat(fragment) === 0;
		await this.registerRoom({
			bucketId,
			roomHash,
			relayUrl,
			roomPin: pin,
			legacy: false,
			isCreator: existing?.isCreator ?? fromFragment
		});

		if (this.rooms.has(bucketId)) {
			this.closeRoomConnection(bucketId);
		}
		await setSeatReleased(bucketId, false);
		return this.openRoom(bucketId);
	}

	private wireClient(bucketId: string, client: RelayClient) {
		const room = this.rooms.get(bucketId);
		if (!room) return;

		client.onStatus = ((s, detail) => {
			const r = this.rooms.get(bucketId);
			if (!r) return;
			if (s === 'open') {
				this.resetReconnectState(bucketId);
				r.runtime.connState = 'open';
				r.runtime.connDetail = '';
				this.startHeartbeat(bucketId);
			} else {
				r.runtime.connState = s as ConnState;
				r.runtime.connDetail = detail ?? '';
				if (s === 'closed' || s === 'error') {
					this.stopHeartbeat(bucketId);
				}
			}
			if (s === 'closed' && detail === 'bucket full') {
				r.runtime.bucketFull = true;
				this.cancelManagedReconnect(bucketId);
				client.close();
				r.client = null;
			}
			if (s === 'closed' || s === 'error') {
				const hasPeerMsgs = (get(messagesByBucket)[bucketId] ?? []).some((m) => m.from === 'peer');
				if (!hasPeerMsgs) r.runtime.peerPresent = false;
			}
			if (s === 'closed' && detail !== 'bucket full') {
				this.handleDisconnectForReconnect(bucketId);
			}
			this.syncRuntimes();
		}) satisfies StatusHandler;

		client.onControl = (msg) => {
			const r = this.rooms.get(bucketId);
			if (!r) return;
			if (msg.t === 'pong') {
				this.onHeartbeatPong(bucketId);
				return;
			}
			if (msg.t === 'slot' && typeof msg.n === 'number') r.runtime.slot = msg.n;
			if (msg.t === 'peer_join') {
				const wasPresent = r.runtime.peerPresent;
				r.runtime.peerPresent = true;
				if (get(activeBucketId) !== bucketId) {
					void getRoom(bucketId).then((rec) => {
						if (rec) notifyPartnerJoined(bucketId, partnerLabel(rec));
					});
				}
				// Relay may emit peer_join on every forwarded frame — only digest on first sight.
				if (!wasPresent) {
					void this.publishDigest(bucketId);
				}
			}
			if (msg.t === 'peer_leave') r.runtime.peerPresent = false;
			this.syncRuntimes();
		};

		client.onBinary = async (buf) => {
			const r = this.rooms.get(bucketId);
			if (!r || r.runtime.bucketFull) return;
			if (!r.runtime.peerPresent) {
				r.runtime.peerPresent = true;
				this.syncRuntimes();
				void this.publishDigest(bucketId);
			}
			try {
				const plain = await decryptMessage(r.key, buf);
				if (plain.type === 'delete') {
					await this.applyDelete(bucketId, plain.id);
					this.schedulePublishDigest(bucketId);
					return;
				}
				if (plain.type === 'image_chunk') {
					await this.handleImageChunk(bucketId, plain);
					return;
				}
				if (plain.type === 'history_digest') {
					await this.onPeerDigest(bucketId, {
						count: plain.count,
						idHash: plain.idHash,
						deviceFp: plain.deviceFp
					});
					return;
				}
				if (plain.type === 'resync_request') {
					await this.onResyncRequest(bucketId, plain.id, plain.ts, plain.deviceFp);
					return;
				}
				if (plain.type === 'wipe_history') {
					await this.applyWipeHistory(bucketId);
					return;
				}
				if (plain.type === 'resync_reject') {
					this.onResyncReject(bucketId, plain.id, plain.reason);
					return;
				}
				if (plain.type === 'resync_accept') {
					await this.onResyncAccept(bucketId, plain.id, plain.ids);
					return;
				}
				if (plain.type === 'resync_ids') {
					await this.onResyncIds(bucketId, plain.id, plain.ids);
					return;
				}
				if (plain.type === 'history_chunk') {
					await this.handleHistoryChunk(bucketId, plain);
					return;
				}
				if (plain.type !== 'text' && plain.type !== 'image') {
					return;
				}
				const stored: StoredMessage = {
					...plain,
					id: plain.id ?? uuidV7(),
					from: 'peer'
				};
				if (!this.appendMessage(bucketId, stored)) return;
				await addMessage(bucketId, stored);
				this.schedulePublishDigest(bucketId);
				const curFp = this.currentPeerDeviceFp.get(bucketId);
				if (curFp) {
					const rec = await getRoom(bucketId);
					if (rec && !rec.lastPeerDeviceFp) {
						await this.trustPeerDeviceFp(bucketId, curFp);
					}
				}
				const preview = messagePreview(plain);
				await touchRoom(bucketId, preview);

				const active = get(activeBucketId);
				const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
				if (active !== bucketId || hidden) {
					await markUnread(bucketId, true);
					bumpRooms();
					const rec = await getRoom(bucketId);
					notifyPartnerMessage({
						body: preview,
						bucketId,
						nickname: partnerLabel(rec),
						onClick: () => {
							void this.navigateToRoom(bucketId);
						}
					});
				}
			} catch (e) {
				console.warn('byteln: decrypt failed', e);
			}
		};
	}

	private async handleImageChunk(bucketId: string, chunk: ImageChunkPlainMessage): Promise<void> {
		this.sweepPendingImages(bucketId);
		let byId = this.pendingImages.get(bucketId);
		if (!byId) {
			byId = new Map();
			this.pendingImages.set(bucketId, byId);
		}

		let pending = byId.get(chunk.id);
		if (!pending) {
			if (chunk.index !== 0) {
				console.warn('byteln: image chunk before header', chunk.id, chunk.index);
				return;
			}
			if (
				typeof chunk.ts !== 'number' ||
				!chunk.mime ||
				typeof chunk.byteLength !== 'number'
			) {
				console.warn('byteln: invalid image chunk header', chunk.id);
				return;
			}
			pending = {
				id: chunk.id,
				total: chunk.total,
				byteLength: chunk.byteLength,
				mime: chunk.mime,
				ts: chunk.ts,
				w: chunk.w,
				h: chunk.h,
				replyTo: chunk.replyTo,
				parts: Array.from({ length: chunk.total }, () => null),
				receivedBytes: 0,
				updatedAt: Date.now()
			};
			byId.set(chunk.id, pending);
		} else if (chunk.total !== pending.total) {
			console.warn('byteln: image chunk total mismatch', chunk.id);
			return;
		}

		if (chunk.index < 0 || chunk.index >= pending.total) return;
		if (pending.parts[chunk.index]) return; // duplicate

		pending.parts[chunk.index] = chunk.data;
		pending.receivedBytes += chunk.data.byteLength;
		pending.updatedAt = Date.now();

		const progress =
			pending.byteLength > 0
				? Math.min(1, pending.receivedBytes / pending.byteLength)
				: pending.parts.every((p) => p !== null)
					? 1
					: 0;

		this.upsertTransfer(bucketId, {
			id: pending.id,
			direction: 'recv',
			progress,
			mime: pending.mime,
			w: pending.w,
			h: pending.h,
			from: 'peer',
			replyTo: pending.replyTo,
			ts: pending.ts
		});

		const complete = pending.parts.every((p) => p !== null);
		if (!complete) return;

		const assembled = new Uint8Array(pending.byteLength);
		let offset = 0;
		for (const part of pending.parts) {
			if (!part) return;
			if (offset + part.byteLength > pending.byteLength) {
				console.warn('byteln: image chunk overflow', chunk.id);
				byId.delete(chunk.id);
				this.removeTransfer(bucketId, chunk.id, 'recv');
				return;
			}
			assembled.set(part, offset);
			offset += part.byteLength;
		}
		if (offset !== pending.byteLength) {
			console.warn('byteln: image assembled size mismatch', chunk.id);
			byId.delete(chunk.id);
			this.removeTransfer(bucketId, chunk.id, 'recv');
			return;
		}

		byId.delete(chunk.id);
		this.removeTransfer(bucketId, chunk.id, 'recv');

		const stored: StoredMessage = {
			v: 1,
			ts: pending.ts,
			type: 'image',
			mime: pending.mime,
			data: assembled,
			id: pending.id,
			from: 'peer'
		};
		if (typeof pending.w === 'number') stored.w = pending.w;
		if (typeof pending.h === 'number') stored.h = pending.h;
		if (pending.replyTo) stored.replyTo = pending.replyTo;

		if (!this.appendMessage(bucketId, stored)) return;
		await addMessage(bucketId, stored);
		const preview = messagePreview(stored);
		await touchRoom(bucketId, preview);

		const active = get(activeBucketId);
		const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
		if (active !== bucketId || hidden) {
			await markUnread(bucketId, true);
			bumpRooms();
			const rec = await getRoom(bucketId);
			notifyPartnerMessage({
				body: preview,
				bucketId,
				nickname: partnerLabel(rec),
				onClick: () => {
					void this.navigateToRoom(bucketId);
				}
			});
		}
	}

	private async waitForRelay(bucketId: string, timeoutMs = 8000): Promise<boolean> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const r = this.rooms.get(bucketId);
			if (!r) return false;
			if (r.runtime.bucketFull) return false;
			if (r.client?.connected) return true;
			if (r.runtime.connState === 'closed' && r.runtime.connDetail === 'bucket full') return false;
			await new Promise((res) => setTimeout(res, 50));
		}
		return !!this.rooms.get(bucketId)?.client?.connected;
	}

	private async connectRelay(bucketId: string, token: string): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room) return false;

		const deviceSessionId = getDeviceSessionId();
		if (!deviceSessionId) return false;

		room.runtime.bucketFull = false;
		if (room.client) {
			await room.client.closeAndWait();
			room.client = null;
		}
		const client = new RelayClient(room.relayUrl, bucketId, token, deviceSessionId, {
			autoReconnect: false
		});
		room.client = client;
		this.wireClient(bucketId, client);
		client.connect();
		return this.waitForRelay(bucketId);
	}

	private closeRoomConnection(bucketId: string) {
		const room = this.rooms.get(bucketId);
		if (!room) return;
		this.cancelManagedReconnect(bucketId);
		this.stopHeartbeat(bucketId);
		room.client?.close();
		room.client = null;
		this.rooms.delete(bucketId);
		this.syncRuntimes();
	}

	closeRoom(bucketId: string) {
		this.closeRoomConnection(bucketId);
		this.creds.delete(bucketId);
		this.clearTransfersForBucket(bucketId);
		messagesByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});
	}

	async forgetRoom(bucketId: string): Promise<void> {
		this.closeRoom(bucketId);
		clearSessionCredentialsFor(bucketId);
		clearRoomSessionStorage(bucketId);
		await removeRoom(bucketId);
		await deleteMessagesForBucket(bucketId);
		if (get(activeBucketId) === bucketId) {
			activeBucketId.set(null);
		}
		bumpRooms();
	}

	/**
	 * Release this room's relay seat for switching devices.
	 * Keeps local history + encrypted credentials; skips auto-reconnect until rejoinRoom.
	 */
	async releaseSeatForSwitch(bucketId: string): Promise<void> {
		const room = this.rooms.get(bucketId);
		this.cancelManagedReconnect(bucketId);
		this.stopHeartbeat(bucketId);
		this.suppressReconnect.add(bucketId);
		try {
			if (room?.client) {
				await room.client.closeAndWait();
			}
			await new Promise((r) => setTimeout(r, 250));
			this.closeRoomConnection(bucketId);
			this.clearTransfersForBucket(bucketId);
			await setSeatReleased(bucketId, true);
			bumpRooms();
		} finally {
			this.suppressReconnect.delete(bucketId);
		}
	}

	/** Clear seatReleased and reconnect to the relay. */
	async rejoinRoom(bucketId: string): Promise<boolean> {
		await setSeatReleased(bucketId, false);
		bumpRooms();
		return this.openRoom(bucketId);
	}

	lock(): void {
		this.appLocked = true;
		this.cancelAllManagedReconnects();
		this.stopAllHeartbeats();
		void this.releaseAllConnections();
	}

	/** Graceful disconnect — releases relay seats before app lock (like refresh). */
	async releaseAllConnections(): Promise<void> {
		this.cancelAllManagedReconnects();
		this.stopAllHeartbeats();
		const ids = [...this.rooms.keys()];
		await Promise.all(
			ids.map(async (id) => {
				const room = this.rooms.get(id);
				if (room?.client) {
					await room.client.closeAndWait();
				}
			})
		);
		// Brief pause so the relay can process Leave before we reconnect on unlock.
		await new Promise((r) => setTimeout(r, 250));
		for (const id of ids) {
			const room = this.rooms.get(id);
			if (room) room.runtime.bucketFull = false;
			this.closeRoomConnection(id);
		}
		this.creds.clear();
		clearSessionCredentials();
	}

	clearAll(): void {
		this.cancelAllManagedReconnects();
		this.stopAllHeartbeats();
		for (const id of [...this.rooms.keys()]) {
			this.closeRoom(id);
		}
		this.creds.clear();
		clearSessionCredentials();
		activeBucketId.set(null);
		roomRuntimes.set({});
		messagesByBucket.set({});
		imageTransfersByBucket.set({});
		historyMismatchByBucket.set({});
		resyncPromptByBucket.set({});
		resyncStatusByBucket.set({});
		this.pendingImages.clear();
		this.pendingHistory.clear();
		this.resyncSessions.clear();
		this.peerDigests.clear();
		this.currentPeerDeviceFp.clear();
		this.expectedHistoryRecv.clear();
	}

	async restoreAll(): Promise<void> {
		this.appLocked = false;
		const records = await listRooms();
		for (const rec of records) {
			if (rec.credentialsEnc && isVaultUnlocked()) {
				const creds = await decryptCredentials(rec.credentialsEnc);
				if (creds) {
					this.creds.set(rec.bucketId, creds);
					stashSessionCredentials(rec.bucketId, creds);
				}
			}
			if (!this.creds.has(rec.bucketId)) continue;
			if (rec.seatReleased) continue;
			try {
				if (this.rooms.get(rec.bucketId)?.client?.connected) continue;
				await this.openRoom(rec.bucketId);
			} catch (e) {
				console.warn('byteln: failed to restore room', rec.bucketId, e);
			}
		}
	}

	async navigateToRoom(bucketId: string): Promise<void> {
		const rec = await getRoom(bucketId);
		if (!rec) return;
		let hash = rec.roomHash || '';
		const creds = this.creds.get(bucketId) ?? getSessionCredentials(bucketId);
		if (creds?.roomHash) hash = creds.roomHash;
		else if (!hash && rec.credentialsEnc && isVaultUnlocked()) {
			const dec = await decryptCredentials(rec.credentialsEnc);
			if (dec) hash = dec.roomHash;
		}
		if (!hash.includes('key=')) {
			await goto(`/b/${bucketId}`);
			return;
		}
		await this.setActive(bucketId);
		await goto(`/b/${bucketId}${hash}`);
	}

	/** Room PIN + hash for creators resharing invite details. */
	async getRoomCredentials(bucketId: string): Promise<RoomCredentials | null> {
		const cached = this.creds.get(bucketId) ?? getSessionCredentials(bucketId);
		if (cached) return cached;
		const rec = await getRoom(bucketId);
		if (rec?.credentialsEnc && isVaultUnlocked()) {
			return decryptCredentials(rec.credentialsEnc);
		}
		return null;
	}

	async getRoomPin(bucketId: string): Promise<string | null> {
		const open = this.rooms.get(bucketId);
		if (open?.roomPin) return open.roomPin;
		const creds = await this.getRoomCredentials(bucketId);
		return creds?.roomPin ?? null;
	}

	/** Decrypt saved room PIN with app PIN (for creators resharing). */
	async revealRoomPin(bucketId: string, appPin: string): Promise<string | null> {
		const rec = await getRoom(bucketId);
		if (!rec?.credentialsEnc) return null;
		const creds = await decryptCredentialsWithPin(rec.credentialsEnc, appPin);
		if (!creds?.roomPin) return null;
		stashSessionCredentials(bucketId, creds);
		this.creds.set(bucketId, creds);
		const open = this.rooms.get(bucketId);
		if (open) open.roomPin = creds.roomPin;
		return creds.roomPin;
	}

	/** Encrypt and save credentials for all rooms (after app PIN setup/unlock). */
	async persistAllCredentials(): Promise<void> {
		if (!isVaultUnlocked()) return;
		const records = await listRooms();
		for (const rec of records) {
			let creds = await this.resolveExistingCredentials(rec.bucketId, rec);
			if (!creds?.roomHash && rec.roomHash) {
				creds = { roomHash: rec.roomHash, roomPin: creds?.roomPin ?? null };
			}
			if (!creds?.roomHash) continue;
			const enc = await encryptCredentials(creds);
			if (!enc) continue;
			await upsertRoom({ ...rec, credentialsEnc: enc });
			this.creds.set(rec.bucketId, creds);
			stashSessionCredentials(rec.bucketId, creds);
		}
	}

	async send(
		bucketId: string,
		body: string,
		opts?: { replyTo?: ReplyRef }
	): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected) return false;

		const id = uuidV7();
		const plain: PlainMessage = { v: 1, ts: Date.now(), type: 'text', body, id };
		if (opts?.replyTo) plain.replyTo = opts.replyTo;
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		const stored: StoredMessage = { ...plain, id, from: 'self' };
		this.appendMessage(bucketId, stored);
		await addMessage(bucketId, stored);
		await touchRoom(bucketId, body);
		bumpRooms();
		this.schedulePublishDigest(bucketId);
		return true;
	}

	async sendImage(
		bucketId: string,
		file: Blob,
		opts?: { replyTo?: ReplyRef }
	): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected) return false;

		const prepared = await prepareImage(file);
		const id = uuidV7();
		const plain: ImagePlainMessage & { id: string } = {
			v: 1,
			ts: Date.now(),
			type: 'image',
			mime: prepared.mime,
			data: prepared.data,
			w: prepared.w,
			h: prepared.h,
			id
		};
		if (opts?.replyTo) plain.replyTo = opts.replyTo;

		const stored: StoredMessage = { ...plain, id, from: 'self' };
		this.appendMessage(bucketId, stored);
		await addMessage(bucketId, stored);
		await touchRoom(bucketId, messagePreview(plain));
		bumpRooms();

		this.upsertTransfer(bucketId, {
			id,
			direction: 'send',
			progress: 0,
			mime: plain.mime,
			w: plain.w,
			h: plain.h,
			from: 'self',
			replyTo: plain.replyTo,
			ts: plain.ts
		});

		const chunks = splitImageChunks(plain);
		const totalBytes = plain.data.byteLength;
		let sentBytes = 0;

		try {
			for (const chunk of chunks) {
				if (!room.client?.connected) {
					this.removeTransfer(bucketId, id, 'send');
					return false;
				}
				const buf = await encryptMessage(room.key, chunk);
				room.client.sendBinary(buf);
				sentBytes += chunk.data.byteLength;
				const progress = totalBytes > 0 ? Math.min(1, sentBytes / totalBytes) : 1;
				this.upsertTransfer(bucketId, {
					id,
					direction: 'send',
					progress,
					mime: plain.mime,
					w: plain.w,
					h: plain.h,
					from: 'self',
					replyTo: plain.replyTo,
					ts: plain.ts
				});
				if (!(await this.waitForBufferedAmountLow(room.client))) {
					this.removeTransfer(bucketId, id, 'send');
					return false;
				}
			}
			this.removeTransfer(bucketId, id, 'send');
			this.schedulePublishDigest(bucketId);
			return true;
		} catch (e) {
			console.warn('byteln: image send failed', e);
			this.removeTransfer(bucketId, id, 'send');
			return false;
		}
	}

	/** Delete for everyone: send encrypted delete signal, then remove locally. */
	async sendDelete(bucketId: string, messageId: string): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected || !messageId) return false;

		const plain: PlainMessage = {
			v: 1,
			ts: Date.now(),
			type: 'delete',
			id: messageId
		};
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		await this.applyDelete(bucketId, messageId);
		return true;
	}

	private async applyDelete(bucketId: string, messageId: string): Promise<void> {
		const map = this.pendingImages.get(bucketId);
		map?.delete(messageId);
		this.removeTransfer(bucketId, messageId);
		const prev = get(messagesByBucket)[bucketId] ?? [];
		const next = prev.filter((m) => m.id !== messageId);
		if (next.length !== prev.length) {
			this.syncMessages(bucketId, next);
		}
		await deleteMessage(bucketId, messageId);
		bumpRooms();
		this.schedulePublishDigest(bucketId);
	}

	async requestResync(bucketId: string): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected || !room.runtime.peerPresent) return false;
		const existing = this.resyncSessions.get(bucketId);
		if (existing && Date.now() - existing.updatedAt < RESYNC_TTL_MS) return false;

		const id = uuidV7();
		const sid = getDeviceSessionId();
		const deviceFp = sid ? await deviceFingerprint(sid) : undefined;
		const plain: PlainMessage = {
			v: 1,
			ts: Date.now(),
			type: 'resync_request',
			id
		};
		if (deviceFp) plain.deviceFp = deviceFp;
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		this.resyncSessions.set(bucketId, {
			requestId: id,
			role: 'requester',
			peerIds: null,
			myIdsSent: false,
			updatedAt: Date.now()
		});
		this.setResyncStatus(bucketId, {
			phase: 'waiting',
			progress: 0,
			requestId: id,
			detail: 'Waiting for peer approval…'
		});
		return true;
	}

	async respondResync(bucketId: string, accept: boolean): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		const prompt = get(resyncPromptByBucket)[bucketId];
		if (!room?.client?.connected || !prompt) return false;

		resyncPromptByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});

		if (!accept) {
			const plain: PlainMessage = {
				v: 1,
				ts: Date.now(),
				type: 'resync_reject',
				id: prompt.requestId,
				reason: 'declined'
			};
			const buf = await encryptMessage(room.key, plain);
			room.client.sendBinary(buf);
			return true;
		}

		if (prompt.deviceFp) {
			await this.trustPeerDeviceFp(bucketId, prompt.deviceFp);
		}

		const msgs = get(messagesByBucket)[bucketId] ?? [];
		const ids = sortMessageIds(msgs.map((m) => m.id));
		const plain: PlainMessage = {
			v: 1,
			ts: Date.now(),
			type: 'resync_accept',
			id: prompt.requestId,
			ids
		};
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		this.resyncSessions.set(bucketId, {
			requestId: prompt.requestId,
			role: 'approver',
			peerIds: null,
			myIdsSent: true,
			updatedAt: Date.now()
		});
		this.setResyncStatus(bucketId, {
			phase: 'waiting',
			progress: 0,
			requestId: prompt.requestId,
			detail: 'Waiting for peer id list…'
		});
		return true;
	}

	private async onResyncRequest(
		bucketId: string,
		requestId: string,
		ts: number,
		deviceFp?: string
	): Promise<void> {
		const fp = deviceFp ?? this.currentPeerDeviceFp.get(bucketId);
		const rec = await getRoom(bucketId);
		let deviceTrust: ResyncPrompt['deviceTrust'] = 'unknown';
		if (fp && rec?.lastPeerDeviceFp) {
			deviceTrust = fp === rec.lastPeerDeviceFp ? 'same' : 'new';
		} else if (fp && !rec?.lastPeerDeviceFp) {
			deviceTrust = 'unknown';
		}
		resyncPromptByBucket.update((m) => ({
			...m,
			[bucketId]: { requestId, ts, deviceFp: fp, deviceTrust }
		}));
	}

	private onResyncReject(bucketId: string, requestId: string, reason?: string) {
		const session = this.resyncSessions.get(bucketId);
		if (!session || session.requestId !== requestId) return;
		this.resyncSessions.delete(bucketId);
		this.setResyncStatus(bucketId, {
			phase: 'error',
			progress: 0,
			detail: reason === 'declined' ? 'Peer declined sync' : 'Sync rejected'
		});
	}

	private async onResyncAccept(
		bucketId: string,
		requestId: string,
		peerIds: string[]
	): Promise<void> {
		const room = this.rooms.get(bucketId);
		const session = this.resyncSessions.get(bucketId);
		if (!room?.client?.connected || !session || session.requestId !== requestId) return;
		if (session.role !== 'requester') return;

		session.peerIds = peerIds;
		session.updatedAt = Date.now();

		const myMsgs = get(messagesByBucket)[bucketId] ?? [];
		const myIds = sortMessageIds(myMsgs.map((m) => m.id));
		const idsPlain: PlainMessage = {
			v: 1,
			ts: Date.now(),
			type: 'resync_ids',
			id: requestId,
			ids: myIds
		};
		const buf = await encryptMessage(room.key, idsPlain);
		room.client.sendBinary(buf);
		session.myIdsSent = true;

		await this.runDifferentialPush(bucketId, requestId, myMsgs, peerIds);
	}

	private async onResyncIds(
		bucketId: string,
		requestId: string,
		peerIds: string[]
	): Promise<void> {
		const session = this.resyncSessions.get(bucketId);
		if (!session || session.requestId !== requestId) return;
		if (session.role !== 'approver') return;

		session.peerIds = peerIds;
		session.updatedAt = Date.now();
		const myMsgs = get(messagesByBucket)[bucketId] ?? [];
		await this.runDifferentialPush(bucketId, requestId, myMsgs, peerIds);
	}

	private async runDifferentialPush(
		bucketId: string,
		requestId: string,
		myMsgs: StoredMessage[],
		peerIds: string[]
	): Promise<void> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected) {
			this.setResyncStatus(bucketId, {
				phase: 'error',
				progress: 0,
				requestId,
				detail: 'Disconnected during sync'
			});
			return;
		}

		const myIds = myMsgs.map((m) => m.id);
		const onlyMine = idsOnlyInA(myIds, peerIds);
		const onlyTheirs = idsOnlyInA(peerIds, myIds);
		const session = this.resyncSessions.get(bucketId);
		const role = session?.role ?? 'requester';
		const bundleId = `${requestId}:${role}`;
		this.expectedHistoryRecv.set(requestId, onlyTheirs.length > 0 ? 1 : 0);

		this.setResyncStatus(bucketId, {
			phase: 'transferring',
			progress: 0,
			requestId,
			detail:
				onlyMine.length === 0 && onlyTheirs.length === 0
					? 'Already in sync'
					: `Sending ${onlyMine.length}, expecting ${onlyTheirs.length}…`
		});

		const toSend = filterMessagesByIds(myMsgs, onlyMine);
		try {
			const compressed = await packMessagesForSync(toSend);
			const chunks = splitHistoryChunks(bundleId, compressed);
			let sent = 0;
			for (const chunk of chunks) {
				if (!room.client?.connected) throw new Error('disconnected');
				const buf = await encryptMessage(room.key, chunk);
				room.client.sendBinary(buf);
				sent += chunk.data.byteLength;
				const progress =
					compressed.byteLength > 0 ? Math.min(1, sent / compressed.byteLength) : 1;
				this.setResyncStatus(bucketId, {
					phase: 'transferring',
					progress: onlyTheirs.length > 0 ? progress * 0.5 : progress,
					requestId,
					detail: `Sending… ${Math.round(progress * 100)}%`
				});
				if (!(await this.waitForBufferedAmountLow(room.client))) {
					throw new Error('disconnected');
				}
			}

			if (onlyTheirs.length === 0) {
				this.finishResyncIfDone(bucketId, requestId);
			}
		} catch (e) {
			console.warn('byteln: history sync send failed', e);
			this.resyncSessions.delete(bucketId);
			this.expectedHistoryRecv.delete(requestId);
			this.setResyncStatus(bucketId, {
				phase: 'error',
				progress: 0,
				requestId,
				detail: e instanceof Error ? e.message : 'Sync send failed'
			});
		}
	}

	private async handleHistoryChunk(
		bucketId: string,
		chunk: HistoryChunkPlainMessage
	): Promise<void> {
		const requestId = chunk.id.includes(':') ? chunk.id.slice(0, chunk.id.indexOf(':')) : chunk.id;
		let pending = this.pendingHistory.get(chunk.id);
		if (!pending) {
			if (chunk.index !== 0) {
				console.warn('byteln: history chunk before header', chunk.id);
				return;
			}
			if (typeof chunk.compressedLength !== 'number') return;
			pending = {
				requestId: chunk.id,
				total: chunk.total,
				compressedLength: chunk.compressedLength,
				parts: Array.from({ length: chunk.total }, () => null),
				receivedBytes: 0,
				updatedAt: Date.now()
			};
			this.pendingHistory.set(chunk.id, pending);
		} else if (chunk.total !== pending.total) {
			return;
		}

		if (chunk.index < 0 || chunk.index >= pending.total) return;
		if (pending.parts[chunk.index]) return;
		pending.parts[chunk.index] = chunk.data;
		pending.receivedBytes += chunk.data.byteLength;
		pending.updatedAt = Date.now();

		const recvProgress =
			pending.compressedLength > 0
				? Math.min(1, pending.receivedBytes / pending.compressedLength)
				: pending.parts.every((p) => p !== null)
					? 1
					: 0;
		this.setResyncStatus(bucketId, {
			phase: 'transferring',
			progress: 0.5 + recvProgress * 0.5,
			requestId,
			detail: `Receiving… ${Math.round(recvProgress * 100)}%`
		});

		if (!pending.parts.every((p) => p !== null)) return;

		const assembled = new Uint8Array(pending.compressedLength);
		let offset = 0;
		for (const part of pending.parts) {
			if (!part) return;
			assembled.set(part, offset);
			offset += part.byteLength;
		}
		this.pendingHistory.delete(chunk.id);

		try {
			const incoming = await unpackMessagesFromSync(assembled);
			await mergeMessages(bucketId, incoming);
			const all = await listMessages(bucketId);
			this.syncMessages(bucketId, all);
			bumpRooms();
			this.expectedHistoryRecv.set(requestId, 0);
			this.finishResyncIfDone(bucketId, requestId);
			this.schedulePublishDigest(bucketId);
		} catch (e) {
			console.warn('byteln: history sync unpack failed', e);
			this.resyncSessions.delete(bucketId);
			this.setResyncStatus(bucketId, {
				phase: 'error',
				progress: 0,
				requestId,
				detail: 'Failed to apply sync payload'
			});
		}
	}

	private finishResyncIfDone(bucketId: string, requestId: string) {
		const expect = this.expectedHistoryRecv.get(requestId) ?? 0;
		if (expect > 0) return;
		this.expectedHistoryRecv.delete(requestId);
		this.resyncSessions.delete(bucketId);
		const fp = this.currentPeerDeviceFp.get(bucketId);
		void this.trustPeerDeviceFp(bucketId, fp);
		this.setResyncStatus(bucketId, {
			phase: 'done',
			progress: 1,
			requestId,
			detail: 'History synced'
		});
		this.schedulePublishDigest(bucketId);
	}

	/** Clear local message history for this room (keeps invite/credentials). */
	async wipeLocalHistory(bucketId: string): Promise<void> {
		await deleteMessagesForBucket(bucketId);
		this.syncMessages(bucketId, []);
		this.pendingImages.delete(bucketId);
		this.setTransfers(bucketId, []);
		resyncPromptByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});
		this.resyncSessions.delete(bucketId);
		await setLastPeerDeviceFp(bucketId, null);
		this.setHistoryMismatch(bucketId, false);
		this.schedulePublishDigest(bucketId);
		bumpRooms();
	}

	/** Wipe local history and ask the peer to wipe theirs too. */
	async wipeBothHistories(bucketId: string): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected) {
			await this.wipeLocalHistory(bucketId);
			return false;
		}
		const plain: PlainMessage = {
			v: 1,
			ts: Date.now(),
			type: 'wipe_history',
			id: uuidV7()
		};
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		await this.wipeLocalHistory(bucketId);
		return true;
	}

	private async applyWipeHistory(bucketId: string): Promise<void> {
		await this.wipeLocalHistory(bucketId);
		this.setResyncStatus(bucketId, {
			phase: 'done',
			progress: 1,
			detail: 'Partner wiped chat history'
		});
	}

	isOpen(bucketId: string): boolean {
		const room = this.rooms.get(bucketId);
		return !!room?.client?.connected;
	}

	getKey(bucketId: string): CryptoKey | null {
		return this.rooms.get(bucketId)?.key ?? null;
	}
}

export const connectionManager = new ConnectionManagerImpl();
