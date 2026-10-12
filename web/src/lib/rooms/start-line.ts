import { goto } from '$app/navigation';
import { env } from '$env/dynamic/public';
import {
	buildRoomHash,
	createPinVerifier,
	generatePinSalt,
	generateRoomPin,
	stashCreatorPin
} from '$lib/crypto/room';
import { exportKeyRaw, generateSessionKey, randomBucketId } from '$lib/crypto/session';
import { connectionManager } from '$lib/relay/connection-manager';
import { defaultRelayUrl } from '$lib/servers/directory';
import { defaultNickname, resolveRelayUrl, setRelayUrl } from '$lib/storage/history';

/** Create and register a new secure line (seat 0) without navigating. */
export async function createSecureLine(
	relayUrl?: string,
	nickname?: string
): Promise<{ id: string; hash: string; pin: string }> {
	const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
	const relay = (relayUrl?.trim() || (await resolveRelayUrl(fallback))).trim();
	if (relay) await setRelayUrl(relay);

	const id = randomBucketId();
	const key = await generateSessionKey();
	const raw = await exportKeyRaw(key);
	const pin = generateRoomPin();
	const salt = generatePinSalt();
	const pv = await createPinVerifier(pin, salt, id);
	const hash = buildRoomHash({ keyRaw: raw, pv, salt, seat: 0 });
	await connectionManager.registerRoom({
		bucketId: id,
		roomHash: hash,
		relayUrl: relay,
		roomPin: pin,
		nickname: nickname ?? defaultNickname(id),
		isCreator: true
	});
	return { id, hash, pin };
}

/** Create a new secure line and navigate to its share/chat screen. */
export async function startSecureLine(relayUrl?: string): Promise<string> {
	const { id, hash, pin } = await createSecureLine(relayUrl);
	stashCreatorPin(id, pin);
	await goto(`/b/${id}${hash}`);
	return id;
}
