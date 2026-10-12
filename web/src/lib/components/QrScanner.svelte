<script lang="ts">
	import { onMount } from 'svelte';

	type Props = {
		onScan: (value: string) => boolean;
	};

	let { onScan }: Props = $props();

	type Detector = { detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
	type DetectorCtor = new (opts: { formats: string[] }) => Detector;

	let video = $state<HTMLVideoElement | null>(null);
	let status = $state<'starting' | 'scanning' | 'unsupported' | 'denied'>('starting');
	let rejected = $state(false);

	onMount(() => {
		const Ctor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
		if (!Ctor || !navigator.mediaDevices?.getUserMedia) {
			status = 'unsupported';
			return;
		}

		let stream: MediaStream | null = null;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let stopped = false;
		const detector = new Ctor({ formats: ['qr_code'] });

		const tick = async () => {
			if (stopped || !video) return;
			try {
				const codes = await detector.detect(video);
				for (const c of codes) {
					if (onScan(c.rawValue)) {
						stop();
						return;
					}
					rejected = true;
				}
			} catch {
				/* frame not ready */
			}
			if (!stopped) timer = setTimeout(tick, 250);
		};

		const stop = () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			stream?.getTracks().forEach((t) => t.stop());
		};

		void (async () => {
			try {
				stream = await navigator.mediaDevices.getUserMedia({
					video: { facingMode: 'environment' },
					audio: false
				});
			} catch {
				status = 'denied';
				return;
			}
			if (stopped || !video) {
				stop();
				return;
			}
			video.srcObject = stream;
			await video.play().catch(() => {});
			status = 'scanning';
			void tick();
		})();

		return stop;
	});
</script>

<div class="scanner">
	{#if status === 'unsupported'}
		<p class="hint">
			This browser can't scan QR codes in the app. Open your phone's camera app and point it at the
			code on your laptop instead.
		</p>
	{:else if status === 'denied'}
		<p class="hint warn">
			Camera access was blocked. Allow it in your browser settings, or scan with your phone's camera
			app instead.
		</p>
	{:else}
		<video bind:this={video} playsinline muted></video>
		<p class="hint">
			{rejected ? "That's not a byteln pairing code — try the one on your laptop." : 'Point at the QR code on your laptop.'}
		</p>
	{/if}
</div>

<style>
	.scanner {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.6rem;
	}

	video {
		width: min(100%, 18rem);
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: 0.5rem;
		border: 1px solid var(--line);
		background: #000;
	}

	.hint {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
		line-height: 1.45;
		text-align: center;
		max-width: 30ch;
	}

	.hint.warn {
		color: var(--danger);
	}
</style>
