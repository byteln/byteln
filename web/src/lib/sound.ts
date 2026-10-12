/** Short synthesized chime for incoming messages (Web Audio — no audio asset). */

import { getSoundEnabled, setSoundEnabled } from '$lib/storage/history';

const MIN_GAP_MS = 1500;

let enabled = true;
let loaded = false;
let ctx: AudioContext | null = null;
let lastPlayedAt = 0;

function audioContext(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	const Ctor =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) return null;
	ctx ??= new Ctor();
	return ctx;
}

export async function loadSoundPreference(): Promise<boolean> {
	try {
		enabled = await getSoundEnabled();
	} catch {
		/* keep default */
	}
	loaded = true;
	return enabled;
}

export function isSoundEnabled(): boolean {
	return enabled;
}

export async function updateSoundEnabled(on: boolean): Promise<void> {
	enabled = on;
	if (on) unlockAudio();
	await setSoundEnabled(on);
}

/** Browsers only start audio after a user gesture. */
export function unlockAudio(): void {
	const c = audioContext();
	if (c && c.state === 'suspended') void c.resume().catch(() => {});
}

export function initSound(): void {
	if (typeof window === 'undefined') return;
	const unlock = () => {
		unlockAudio();
		window.removeEventListener('pointerdown', unlock);
		window.removeEventListener('keydown', unlock);
	};
	window.addEventListener('pointerdown', unlock);
	window.addEventListener('keydown', unlock);
	if (!loaded) void loadSoundPreference();
}

export function playMessageSound(): void {
	if (!enabled) return;
	const now = Date.now();
	if (now - lastPlayedAt < MIN_GAP_MS) return;
	const c = ctx;
	if (!c || c.state !== 'running') return;
	lastPlayedAt = now;

	const t = c.currentTime;
	const gain = c.createGain();
	gain.connect(c.destination);
	gain.gain.setValueAtTime(0.0001, t);
	gain.gain.exponentialRampToValueAtTime(0.16, t + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
	for (const [freq, offset] of [
		[880, 0],
		[1318.5, 0.085]
	] as const) {
		const osc = c.createOscillator();
		osc.type = 'sine';
		osc.frequency.setValueAtTime(freq, t + offset);
		osc.connect(gain);
		osc.start(t + offset);
		osc.stop(t + 0.42);
	}
}
