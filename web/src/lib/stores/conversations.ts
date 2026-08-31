import { writable } from 'svelte/store';

/** Bumped when room list metadata changes (unread, preview, nickname). */
export const roomsRevision = writable(0);

export function bumpRooms(): void {
	roomsRevision.update((n) => n + 1);
}
