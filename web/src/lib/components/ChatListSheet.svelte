<script lang="ts">
	import { goto } from '$app/navigation';
	import ConversationTabs from '$lib/components/ConversationTabs.svelte';

	type Props = {
		open: boolean;
		onClose: () => void;
	};

	let { open, onClose }: Props = $props();

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') onClose();
	}

	async function newLine() {
		await goto('/app');
		onClose();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="sheet-overlay" role="presentation">
		<button type="button" class="sheet-scrim" aria-label="Close chats" onclick={onClose}></button>
		<div
			class="sheet-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="chats-sheet-title"
			tabindex="-1"
		>
			<header class="sheet-header">
				<h2 id="chats-sheet-title">Your chats</h2>
				<button type="button" class="new-line" onclick={() => void newLine()}>New line</button>
			</header>
			<div class="sheet-body">
				<ConversationTabs variant="sheet" onSelect={onClose} />
			</div>
		</div>
	</div>
{/if}

<style>
	.sheet-overlay {
		position: fixed;
		inset: 0;
		z-index: 250;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
	}

	.sheet-scrim {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		margin: 0;
		background: rgba(0, 0, 0, 0.55);
		cursor: default;
	}

	.sheet-panel {
		position: relative;
		z-index: 1;
		width: 100%;
		max-height: 70dvh;
		display: flex;
		flex-direction: column;
		background: var(--bg1);
		border: 1px solid var(--line);
		border-bottom: none;
		border-radius: 0.75rem 0.75rem 0 0;
		padding-bottom: env(safe-area-inset-bottom, 0px);
		box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.35);
	}

	.sheet-header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1rem 1.15rem 0.85rem;
		border-bottom: 1px solid var(--line);
	}

	.sheet-header h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
		color: var(--ink);
	}

	.new-line {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.45rem 0.75rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--accent);
		font-weight: 600;
		font-size: 0.88rem;
		flex-shrink: 0;
	}

	.sheet-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 0.85rem 1.15rem 1rem;
	}
</style>
