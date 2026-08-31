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
	verifyRoomPin,
	type RoomFragment
} from '$lib/crypto/room';
import {
	decryptMessage,
	encryptMessage,
	importKeyRaw,
	randomToken,
	type PlainMessage
} from '$lib/crypto/session';
import {
	notifyPartnerJoined,
	notifyPartnerMessage
} from '$lib/notify';
import { RelayClient, type StatusHandler } from '$lib/relay/client';
import { bumpRooms } from '$lib/stores/conversations';
import {
	addMessage,
	defaultNickname,
	getRoom,
	getSessionToken,
	deleteMessagesForBucket,
	listMessages,
	listRooms,
	markRead,
	markUnread,
	partnerLabel,
	removeRoom,
	clearRoomSessionStorage,
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
		for (const [id, r] of this.rooms) out[id] = r.runtime;
		roomRuntimes.set(out);
	}

	private syncMessages(bucketId: string, messages: StoredMessage[]) {
		messagesByBucket.update((m) => ({ ...m, [bucketId]: messages }));
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
		await this.registerRoom({
			bucketId,
			roomHash,
			relayUrl,
			roomPin: pin,
			legacy: false,
			isCreator: existing?.isCreator ?? false
		});

		if (this.rooms.has(bucketId)) {
			this.closeRoomConnection(bucketId);
		}
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
				r.runtime.peerPresent = true;
				if (get(activeBucketId) !== bucketId) {
					void getRoom(bucketId).then((rec) => {
						if (rec) notifyPartnerJoined(bucketId, partnerLabel(rec));
					});
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
			}
			try {
				const plain = await decryptMessage(r.key, buf);
				const stored: StoredMessage = {
					...plain,
					id: crypto.randomUUID(),
					from: 'peer'
				};
				const msgs = [...(get(messagesByBucket)[bucketId] ?? []), stored];
				this.syncMessages(bucketId, msgs);
				await addMessage(bucketId, stored);
				await touchRoom(bucketId, plain.body);

				const active = get(activeBucketId);
				const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
				if (active !== bucketId || hidden) {
					await markUnread(bucketId, true);
					bumpRooms();
					const rec = await getRoom(bucketId);
					notifyPartnerMessage({
						body: plain.body,
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
		messagesByBucket.update((m) => {
			const next = { ...m };
			delete next[bucketId];
			return next;
		});
	}

	async forgetRoom(bucketId: string, deleteMessages = false): Promise<void> {
		this.closeRoom(bucketId);
		clearSessionCredentialsFor(bucketId);
		clearRoomSessionStorage(bucketId);
		await removeRoom(bucketId);
		if (deleteMessages) {
			await deleteMessagesForBucket(bucketId);
		}
		if (get(activeBucketId) === bucketId) {
			activeBucketId.set(null);
		}
		bumpRooms();
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

	async send(bucketId: string, body: string): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (!room?.client?.connected) return false;

		const plain: PlainMessage = { v: 1, ts: Date.now(), type: 'text', body };
		const buf = await encryptMessage(room.key, plain);
		room.client.sendBinary(buf);
		const stored: StoredMessage = { ...plain, id: crypto.randomUUID(), from: 'self' };
		const msgs = [...(get(messagesByBucket)[bucketId] ?? []), stored];
		this.syncMessages(bucketId, msgs);
		await addMessage(bucketId, stored);
		await touchRoom(bucketId, body);
		bumpRooms();
		return true;
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
