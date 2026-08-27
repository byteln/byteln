export type DirectoryServer = {
	url: string;
	name: string;
	region?: string;
	maintainer?: string;
};

export const DEFAULT_PUBLIC_RELAY = 'wss://byteln.dev';
export const DEFAULT_LOCAL_RELAY = 'ws://127.0.0.1:8990';

const LOCAL_DEV: DirectoryServer = {
	url: DEFAULT_LOCAL_RELAY,
	name: 'Local Dev Relay',
	region: 'local',
	maintainer: 'github:byteln'
};

const CACHE_KEY = 'byteln:servers.json';
const CACHE_AT = 'byteln:servers.json:at';

export function isUiOnLocalhost(): boolean {
	if (typeof location === 'undefined') return false;
	const h = location.hostname;
	return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

export function isLocalRelayUrl(url: string): boolean {
	try {
		const u = new URL(url.replace(/^ws/i, 'http'));
		return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
	} catch {
		return /localhost|127\.0\.0\.1/.test(url);
	}
}

/** Default relay: local when UI is on localhost, otherwise byteln.dev. */
export function defaultRelayUrl(envOverride?: string): string {
	if (envOverride) return envOverride;
	return isUiOnLocalhost() ? DEFAULT_LOCAL_RELAY : DEFAULT_PUBLIC_RELAY;
}

/** Hide local relays unless the app itself is opened on localhost/127. */
export function filterDirectoryForUi(servers: DirectoryServer[]): DirectoryServer[] {
	const local = isUiOnLocalhost();
	let list = servers.filter((s) => local || !isLocalRelayUrl(s.url));
	if (local && !list.some((s) => isLocalRelayUrl(s.url))) {
		list = [LOCAL_DEV, ...list];
	}
	// Ensure public default appears when not already listed.
	if (!list.some((s) => s.url.replace(/\/$/, '') === DEFAULT_PUBLIC_RELAY)) {
		list = [
			{
				url: DEFAULT_PUBLIC_RELAY,
				name: 'byteln.dev',
				region: 'global',
				maintainer: 'github:byteln'
			},
			...list
		];
	}
	return list;
}

export async function loadDirectory(directoryUrl: string | undefined): Promise<DirectoryServer[]> {
	const cached = readCache();
	if (!directoryUrl) {
		return filterDirectoryForUi(cached ?? []);
	}

	try {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 4000);
		const res = await fetch(directoryUrl, { signal: ctrl.signal });
		clearTimeout(t);
		if (!res.ok) throw new Error(String(res.status));
		const data = (await res.json()) as DirectoryServer[];
		if (Array.isArray(data)) {
			localStorage.setItem(CACHE_KEY, JSON.stringify(data));
			localStorage.setItem(CACHE_AT, String(Date.now()));
			return filterDirectoryForUi(data);
		}
	} catch {
		if (cached) return filterDirectoryForUi(cached);
	}
	return filterDirectoryForUi(cached ?? []);
}

function readCache(): DirectoryServer[] | null {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const data = JSON.parse(raw) as DirectoryServer[];
		return Array.isArray(data) ? data : null;
	} catch {
		return null;
	}
}

/** Health ping: GET {httpBase}/health derived from wss URL. Needs CORS on the relay. */
export async function pingServer(wsUrl: string): Promise<boolean> {
	try {
		const http = wsUrl.replace(/^ws/, 'http').replace(/\/$/, '');
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), 3000);
		const res = await fetch(`${http}/health`, { signal: ctrl.signal, mode: 'cors' });
		clearTimeout(t);
		return res.ok;
	} catch {
		return false;
	}
}
