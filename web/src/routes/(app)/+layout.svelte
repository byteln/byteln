<script lang="ts">
	import VaultGate from '$lib/components/VaultGate.svelte';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,600;1,9..40,400&family=Syne:wght@600;700;800&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="shell">
	<div class="glow" aria-hidden="true"></div>
	<VaultGate>
		{@render children()}
	</VaultGate>
</div>

<style>
	:global(:root) {
		--bg0: #0a0c0e;
		--bg1: #101317;
		--ink: #e7eaee;
		--muted: #838c97;
		--accent: #3ddcb0;
		--accent-dim: rgba(61, 220, 176, 0.14);
		--danger: #e06b5c;
		--line: #23282e;
		--font-display: 'Syne', sans-serif;
		--font-body: 'DM Sans', sans-serif;
	}

	:global(html, body) {
		background: var(--bg0);
		color: var(--ink);
		font-family: var(--font-body);
	}

	:global(a) {
		color: var(--accent);
	}

	.shell {
		position: relative;
		min-height: 100dvh;
		overflow-x: hidden;
	}

	.glow {
		pointer-events: none;
		position: fixed;
		inset: -20% -10% auto;
		height: 60vh;
		background:
			radial-gradient(ellipse 50% 40% at 20% 20%, rgba(61, 220, 176, 0.16), transparent 70%),
			radial-gradient(ellipse 40% 50% at 80% 10%, rgba(61, 220, 176, 0.08), transparent 65%);
		animation: drift 14s ease-in-out infinite alternate;
	}

	@keyframes drift {
		from {
			transform: translate3d(0, 0, 0) scale(1);
		}
		to {
			transform: translate3d(2%, 3%, 0) scale(1.05);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.glow {
			animation: none;
		}
	}
</style>
