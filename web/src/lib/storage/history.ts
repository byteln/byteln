import type { StoredMessage } from '$lib/crypto/backup';

const DB_NAME = 'byteln';
const DB_VERSION = 1;
const STORE = 'messages';
const META = 'meta';

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
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

type Row = StoredMessage & { pk: string; bucketId: string };

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

export async function getSessionToken(bucketId: string): Promise<string | null> {
	// Per-tab storage so two tabs (or refresh reclaim) don't steal each other's slot.
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
		/* private mode quirks — token still used in-memory this session */
	}
}

export async function getRelayUrl(): Promise<string | null> {
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(META, 'readonly');
		const req = tx.objectStore(META).get('relayUrl');
		req.onsuccess = () => {
			const row = req.result as { key: string; value: string } | undefined;
			resolve(row?.value ?? null);
		};
		req.onerror = () => reject(req.error);
	});
}

/** Resolve relay URL, migrating stale local defaults. */
export async function resolveRelayUrl(fallback: string): Promise<string> {
	const saved = await getRelayUrl();
	if (!saved) return fallback;
	// Old defaults before port / public host changes.
	if (
		/localhost:8080|127\.0\.0\.1:8080|localhost:8990|127\.0\.0\.1:8990/.test(saved) &&
		!/localhost|127\.0\.0\.1/.test(fallback)
	) {
		// Saved local relay but UI is no longer on localhost — prefer public default.
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
	const db = await openDb();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(META, 'readwrite');
		tx.objectStore(META).put({ key: 'relayUrl', value: url });
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}
