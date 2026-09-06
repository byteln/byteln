import type { StoredMessage } from '$lib/crypto/backup';
import type { EncryptedBlob } from '$lib/crypto/vault';

import { defaultLineNickname } from '$lib/brand';

const DB_NAME = 'byteln';
const DB_VERSION = 2;
const STORE = 'messages';
const META = 'meta';
const ROOMS = 'rooms';

export type RoomRecord = {
	bucketId: string;
	/** Local label for your partner in this chat (only on this device). */
	nickname: string;
	/** URL fragment (#key=…) — needed to reopen this chat from the list. */
	roomHash: string;
	relayUrl: string;
	createdAt: number;
	lastActiveAt: number;
	lastPreview?: string;
	unread?: boolean;
	credentialsEnc?: EncryptedBlob;
	legacy?: boolean;
	/** True when you created this room (seat 0) — can share the invite (link + PIN). */
	isCreator?: boolean;
};

export function partnerLabel(rec: RoomRecord | null | undefined): string {
	if (!rec) return 'Partner';
	return rec.nickname.trim() || 'Partner';
}

function openDb(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) {
				const s = db.createObjectStore(STORE, { keyPath: 'pk' });
				s.createIndex('byBucket', 'bucketId', { unique: false });
			}
			if (!db.objectStoreNames.contains(META)) {
				db.createObjectStore(META, { keyPath: 'key' });
			}
			if (!db.objectStoreNames.contains(ROOMS)) {
				db.createObjectStore(ROOMS, { keyPath: 'bucketId' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

type Row = StoredMessage & { pk: string; bucketId: string };

export function defaultNickname(bucketId: string): string {
	return defaultLineNickname(bucketId);
}

export async function listMessages(bucketId: string): Promise<StoredMessage[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readonly');
		const idx = tx.objectStore(STORE).index('byBucket');
		const req = idx.getAll(bucketId);
		req.onsuccess = () => {
			const rows = (req.result as Row[]).sort((a, b) => a.ts - b.ts);
			resolve(rows.map(({ id, from, v, ts, type, body }) => ({ id, from, v, ts, type, body })));
		};
		req.onerror = () => reject(req.error);
	});
}

export async function addMessage(bucketId: string, msg: StoredMessage): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put({ ...msg, pk: `${bucketId}:${msg.id}`, bucketId });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function mergeMessages(bucketId: string, msgs: StoredMessage[]): Promise<void> {
	const existing = await listMessages(bucketId);
	const seen = new Set(existing.map((m) => m.id));
	for (const m of msgs) {
		if (!seen.has(m.id)) {
			await addMessage(bucketId, m);
			seen.add(m.id);
		}
	}
}

export async function deleteMessagesForBucket(bucketId: string): Promise<void> {
	const db = await openDb();
	const existing = await listMessages(bucketId);
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		const store = tx.objectStore(STORE);
		for (const m of existing) {
			store.delete(`${bucketId}:${m.id}`);
		}
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function getSessionToken(bucketId: string): Promise<string | null> {
	try {
		return sessionStorage.getItem(`byteln:token:${bucketId}`);
	} catch {
		return null;
	}
}

export async function setSessionToken(bucketId: string, token: string): Promise<void> {
	try {
		sessionStorage.setItem(`byteln:token:${bucketId}`, token);
	} catch {
		/* private mode */
	}
}

export function clearRoomSessionStorage(bucketId: string): void {
	try {
		sessionStorage.removeItem(`byteln:token:${bucketId}`);
		sessionStorage.removeItem(`byteln:pin-once:${bucketId}`);
	} catch {
		/* private mode */
	}
}

export async function getMetaEntry(key: string): Promise<{ key: string; value: string } | undefined> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(META, 'readonly');
		const req = tx.objectStore(META).get(key);
		req.onsuccess = () => resolve(req.result as { key: string; value: string } | undefined);
		req.onerror = () => reject(req.error);
	});
}

export async function setMetaEntry(key: string, value: string): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(META, 'readwrite');
		tx.objectStore(META).put({ key, value });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function getRelayUrl(): Promise<string | null> {
	const row = await getMetaEntry('relayUrl');
	return row?.value ?? null;
}

/** Resolve relay URL, migrating stale local defaults. */
export async function resolveRelayUrl(fallback: string): Promise<string> {
	const saved = await getRelayUrl();
	if (!saved) return fallback;
	if (
		/localhost:8080|127\.0\.0\.1:8080|localhost:8990|127\.0\.0\.1:8990/.test(saved) &&
		!/localhost|127\.0\.0\.1/.test(fallback)
	) {
		await setRelayUrl(fallback);
		return fallback;
	}
	if (/localhost:8080|127\.0\.0\.1:8080/.test(saved)) {
		await setRelayUrl(fallback);
		return fallback;
	}
	return saved;
}

export async function setRelayUrl(url: string): Promise<void> {
	await setMetaEntry('relayUrl', url.trim());
}

const INTRO_SEEN_KEY = 'introSeen';

export async function hasSeenIntro(): Promise<boolean> {
	const row = await getMetaEntry(INTRO_SEEN_KEY);
	return row?.value === '1';
}

export async function markIntroSeen(): Promise<void> {
	await setMetaEntry(INTRO_SEEN_KEY, '1');
}

export async function upsertRoom(record: RoomRecord): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(ROOMS, 'readwrite');
		tx.objectStore(ROOMS).put(record);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function getRoom(bucketId: string): Promise<RoomRecord | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(ROOMS, 'readonly');
		const req = tx.objectStore(ROOMS).get(bucketId);
		req.onsuccess = () => resolve((req.result as RoomRecord | undefined) ?? null);
		req.onerror = () => reject(req.error);
	});
}

export async function listRooms(): Promise<RoomRecord[]> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(ROOMS, 'readonly');
		const req = tx.objectStore(ROOMS).getAll();
		req.onsuccess = () => {
			const rows = (req.result as RoomRecord[]).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
			resolve(rows);
		};
		req.onerror = () => reject(req.error);
	});
}

export async function setNickname(bucketId: string, nickname: string): Promise<void> {
	const room = await getRoom(bucketId);
	if (!room) return;
	await upsertRoom({ ...room, nickname: nickname.trim() || defaultNickname(bucketId) });
}

export async function markUnread(bucketId: string, unread = true): Promise<void> {
	const room = await getRoom(bucketId);
	if (!room) return;
	await upsertRoom({ ...room, unread });
}

export async function markRead(bucketId: string): Promise<void> {
	const room = await getRoom(bucketId);
	if (!room || !room.unread) return;
	await upsertRoom({ ...room, unread: false });
}

export async function touchRoom(bucketId: string, preview?: string): Promise<void> {
	const room = await getRoom(bucketId);
	if (!room) return;
	await upsertRoom({
		...room,
		lastActiveAt: Date.now(),
		...(preview !== undefined ? { lastPreview: preview.slice(0, 120) } : {})
	});
}

export async function removeRoom(bucketId: string): Promise<void> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(ROOMS, 'readwrite');
		tx.objectStore(ROOMS).delete(bucketId);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

export async function saveRoomCredentials(
	bucketId: string,
	patch: Partial<Pick<RoomRecord, 'credentialsEnc' | 'relayUrl' | 'legacy'>>
): Promise<void> {
	const room = await getRoom(bucketId);
	if (!room) return;
	await upsertRoom({ ...room, ...patch });
}

/** Remove all byteln keys from sessionStorage (relay tokens, one-time PINs, etc.). */
export function clearBytelnSessionStorage(): void {
	try {
		const keys: string[] = [];
		for (let i = 0; i < sessionStorage.length; i++) {
			const key = sessionStorage.key(i);
			if (key?.startsWith('byteln:')) keys.push(key);
		}
		for (const key of keys) sessionStorage.removeItem(key);
	} catch {
		/* private mode */
	}
}

/** Wipe IndexedDB — chats, messages, app PIN vault, relay preference. */
export async function clearAllLocalData(): Promise<void> {
	let db: IDBDatabase | null = null;
	try {
		db = await openDb();
	} catch {
		/* already gone */
	}
	if (db) {
		db.close();
		await new Promise<void>((resolve, reject) => {
			const req = indexedDB.deleteDatabase(DB_NAME);
			req.onsuccess = () => resolve();
			req.onerror = () => reject(req.error);
			req.onblocked = () => resolve();
		});
	}
	clearBytelnSessionStorage();
}
