<script lang="ts">
	import ConversationTabs from '$lib/components/ConversationTabs.svelte';
	import { startSecureLine } from '$lib/rooms/start-line';

	let busy = $state(false);

	async function newLine() {
		if (busy) return;
		busy = true;
		try {
			await startSecureLine();
		} finally {
			busy = false;
		}
	}
</script>

<div class="side-panel">
	<header class="side-header">
		<h2 id="chats-side-title">Your chats</h2>
		<button type="button" class="new-line" disabled={busy} onclick={() => void newLine()}>
			{busy ? 'Opening…' : 'New secure line'}
		</button>
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
		background: var(--accent);
		color: #06110d;
		font-weight: 700;
		font-size: 0.88rem;
		flex-shrink: 0;
	}

	.new-line:disabled {
		opacity: 0.65;
		cursor: wait;
	}

	.side-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		-webkit-overflow-scrolling: touch;
		padding: 0.85rem 1.15rem 1rem;
	}
</style>
