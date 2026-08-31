<script lang="ts">
	import { encode } from 'uqr';

	type Props = {
		value: string;
		compact?: boolean;
	};

	let { value, compact = false }: Props = $props();

	const qr = $derived(value ? encode(value, { ecc: 'M', boostEcc: true, border: 4 }) : null);

	const modules = $derived.by(() => {
		if (!qr) return '';
		let d = '';
		for (let y = 0; y < qr.size; y++) {
			const row = qr.data[y];
			if (!row) continue;
			for (let x = 0; x < qr.size; x++) {
				if (row[x]) d += `M${x} ${y}h1v1h-1z`;
			}
		}
		return d;
	});
</script>

{#if qr && modules}
	<figure class={['qr', compact && 'compact']}>
		<svg
			viewBox="0 0 {qr.size} {qr.size}"
			role="img"
			aria-label="QR code for the share link. The room PIN is not included."
			shape-rendering="crispEdges"
		>
			<rect width={qr.size} height={qr.size} fill="#fff" />
			<path d={modules} fill="#090B0D" />
		</svg>
		<figcaption>
			{#if compact}
				Scan to open the link — PIN stays separate.
			{:else}
				Hold this up if you're face to face. They scan the link, then type the PIN.
			{/if}
		</figcaption>
	</figure>
{/if}

<style>
	.qr {
		margin: 0.25rem 0 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.65rem;
	}

	svg {
		width: min(100%, 13.5rem);
		height: auto;
		aspect-ratio: 1;
		border-radius: 0.5rem;
		background: #fff;
	}

	.compact {
		margin-top: 0.15rem;
	}

	.compact svg {
		width: min(100%, 10rem);
	}

	figcaption {
		margin: 0;
		font-size: 0.8rem;
		color: var(--muted);
		line-height: 1.45;
		text-align: center;
		max-width: 28ch;
	}
</style>
