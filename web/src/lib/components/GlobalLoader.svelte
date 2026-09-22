<script lang="ts">
	import { globalLoader } from '$lib/stores/global-loader.svelte';
</script>

{#if globalLoader.visible}
	<div class="global-loader" role="status" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>{globalLoader.message}</p>
	</div>
{/if}

<style>
	.global-loader {
		position: fixed;
		inset: 0;
		z-index: 400;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.85rem;
		background: rgba(9, 11, 13, 0.6);
		backdrop-filter: blur(2px);
		text-align: center;
		padding: 1.5rem;
	}

	.spinner {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: 50%;
		border: 3px solid var(--accent-dim);
		border-top-color: var(--accent);
		animation: global-loader-spin 0.75s linear infinite;
	}

	.global-loader p {
		margin: 0;
		font-size: 0.9rem;
		color: var(--muted);
	}

	@keyframes global-loader-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 1.6s;
		}
	}
</style>
