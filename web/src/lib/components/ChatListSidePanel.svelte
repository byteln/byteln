<script lang="ts">
	import { goto } from '$app/navigation';
	import ConversationTabs from '$lib/components/ConversationTabs.svelte';

	async function newLine() {
		await goto('/app');
	}
</script>

<div class="side-panel">
	<header class="side-header">
		<h2 id="chats-side-title">Your chats</h2>
		<button type="button" class="new-line" onclick={() => void newLine()}>New line</button>
	</header>
	<div class="side-body">
		<ConversationTabs variant="sheet" />
	</div>
</div>

<style>
	.side-panel {
		display: flex;
		flex-direction: column;
		width: 100%;
		height: 100%;
		min-height: 0;
		background: var(--bg1);
		border-right: 1px solid var(--line);
	}

	.side-header {
		position: sticky;
		top: 0;
		z-index: 1;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1rem 1.15rem 0.85rem;
		border-bottom: 1px solid var(--line);
		background: var(--bg1);
	}

	.side-header h2 {
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

	.side-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 0.85rem 1.15rem 1rem;
	}
</style>
