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

const MAX_OPEN_ROOMS = 10;

export const activeBucketId = writable<string | null>(null);
export const roomRuntimes = writable<Record<string, RoomRuntime>>({});
export const messagesByBucket = writable<Record<string, StoredMessage[]>>({});

class ConnectionManagerImpl {
	private rooms = new Map<string, InternalRoom>();
	private creds = new Map<string, RoomCredentials>();
	/** One connect flow per room — avoids duplicate WebSockets on refresh. */
	private openPromises = new Map<string, Promise<boolean>>();

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

		const promise = this.doReconnectRoom(bucketId);
		this.openPromises.set(bucketId, promise);
		try {
			return await promise;
		} finally {
			this.openPromises.delete(bucketId);
		}
	}

	private async doReconnectRoom(bucketId: string): Promise<boolean> {
		const room = this.rooms.get(bucketId);
		if (room) {
			room.runtime.bucketFull = false;
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
	}

	private async connectRoom(bucketId: string): Promise<boolean> {
		const existing = this.rooms.get(bucketId);
		if (!existing) return false;
		if (existing.client?.connected) return true;

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
	}

	private async doOpenRoom(bucketId: string): Promise<boolean> {
		const existing = this.rooms.get(bucketId);
		if (existing?.client?.connected) return true;

		if (existing) {
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
			bucketFull: false
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
			r.runtime.connState = s as ConnState;
			r.runtime.connDetail = detail ?? '';
			if (s === 'closed' && detail === 'bucket full') {
				r.runtime.bucketFull = true;
				client.close();
				r.client = null;
			}
			if (s === 'closed' || s === 'error') {
				const hasPeerMsgs = (get(messagesByBucket)[bucketId] ?? []).some((m) => m.from === 'peer');
				if (!hasPeerMsgs) r.runtime.peerPresent = false;
			}
			this.syncRuntimes();
		}) satisfies StatusHandler;

		client.onControl = (msg) => {
			const r = this.rooms.get(bucketId);
			if (!r) return;
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
		void this.releaseAllConnections();
	}

	/** Graceful disconnect — releases relay seats before app lock (like refresh). */
	async releaseAllConnections(): Promise<void> {
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
