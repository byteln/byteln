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

/** Create a new secure line and navigate to its share/chat screen. */
export async function startSecureLine(relayUrl?: string): Promise<string> {
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
	stashCreatorPin(id, pin);
	await connectionManager.registerRoom({
		bucketId: id,
		roomHash: hash,
		relayUrl: relay,
		roomPin: pin,
		nickname: defaultNickname(id),
		isCreator: true
	});
	await goto(`/b/${id}${hash}`);
	return id;
}
