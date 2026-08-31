/** User-facing labels — app is byteln; a chat channel is a “secure line”. */

export const APP_NAME = 'byteln';

/** Noun for the encrypted two-peer channel (internal id: bucketId). */
export const SECURE_LINE = 'secure line';

export const LINE_ID_LABEL = 'Line ID';

export function defaultLineNickname(lineId: string): string {
	return `Secure line · ${lineId.slice(0, 4)}`;
}

/** Label for the other person in chat — avoid using the line name as a person name. */
export function partnerDisplayName(nickname: string, lineId: string): string {
	const trimmed = nickname.trim();
	if (!trimmed || trimmed === defaultLineNickname(lineId)) return 'Partner';
	return trimmed;
}
