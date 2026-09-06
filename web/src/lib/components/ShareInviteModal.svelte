<script lang="ts">
	import ShareInvitePanel from '$lib/components/ShareInvitePanel.svelte';
	import type { RoomRecord } from '$lib/storage/history';

	type Props = {
		room: RoomRecord;
		onClose: () => void;
	};

	let { room, onClose }: Props = $props();
</script>

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_interactive_supports_focus -->
<div class="modal-overlay" role="dialog" tabindex="-1" aria-labelledby="share-title" onclick={onClose}>
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
		<h3 id="share-title">Share</h3>
		<p class="modal-hint">For “{room.nickname}” — only you can see this.</p>
		<ShareInvitePanel bucketId={room.bucketId} />
		<div class="modal-actions">
			<button type="button" onclick={onClose}>Close</button>
		</div>
	</div>
</div>

<style>
	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 200;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}

	.modal-dialog {
		width: min(24rem, 100%);
		background: var(--bg1);
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		padding: 1.1rem 1.15rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.modal-dialog h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.05rem;
	}

	.modal-hint {
		margin: 0;
		font-size: 0.88rem;
		color: var(--muted);
		line-height: 1.45;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		margin-top: 0.25rem;
	}

	.modal-actions button {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.5rem 0.85rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
	}
</style>
