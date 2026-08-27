<!-- Signature mark: two peers, one relayed line (recommended). -->
<svg
	class="mark"
	width={size}
	height={Math.round((size * 3) / 4)}
	viewBox="0 0 120 90"
	fill="none"
	xmlns="http://www.w3.org/2000/svg"
	aria-hidden="true"
>
	<path
		id="markPath"
		d="M22 45 C 45 45, 45 45, 60 45 C 75 45, 75 45, 98 45"
		stroke="#2A3138"
		stroke-width="1.5"
	/>
	<circle cx="22" cy="45" r="7" fill="var(--bg0, #0A0C0E)" stroke="var(--accent, #3DDCB0)" stroke-width="2" />
	<circle cx="98" cy="45" r="7" fill="var(--bg0, #0A0C0E)" stroke="var(--accent, #3DDCB0)" stroke-width="2" />
	<circle
		class="pulse"
		r="3.2"
		fill="var(--accent, #3DDCB0)"
		style="offset-path: path('M22 45 C 45 45, 45 45, 60 45 C 75 45, 75 45, 98 45')"
	/>
</svg>

<script lang="ts">
	let { size = 120 }: { size?: number } = $props();
</script>

<style>
	.mark {
		display: block;
		flex-shrink: 0;
	}

	.pulse {
		animation: travel 3.2s ease-in-out infinite;
	}

	@keyframes travel {
		0% {
			offset-distance: 0%;
			opacity: 0;
		}
		8% {
			opacity: 1;
		}
		46% {
			opacity: 1;
		}
		50% {
			offset-distance: 100%;
			opacity: 0;
		}
		54% {
			opacity: 0;
		}
		58% {
			opacity: 1;
		}
		92% {
			opacity: 1;
		}
		100% {
			offset-distance: 0%;
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pulse {
			animation: none;
			opacity: 0.9;
			offset-distance: 50%;
		}
	}
</style>
