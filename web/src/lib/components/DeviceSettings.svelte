<script lang="ts">
	import { goto } from '$app/navigation';
	import { clearAllLocal, lockApp } from '$lib/app-session';
	import { hasVault } from '$lib/crypto/vault';
	import { bumpRooms, roomsRevision } from '$lib/stores/conversations';
	import { listRooms } from '$lib/storage/history';
	import { onMount } from 'svelte';

	type Props = {
		compact?: boolean;
	};

	let { compact = false }: Props = $props();

	let hasVaultPin = $state(false);
	let hasChats = $state(false);
	let confirmClear = $state(false);
	let busy = $state(false);

	async function refresh() {
		hasVaultPin = await hasVault();
		hasChats = (await listRooms()).length > 0;
	}

	onMount(() => {
		void refresh();
		const unsub = roomsRevision.subscribe(() => {
			void refresh();
		});
		return unsub;
	});

	async function doLock() {
		busy = true;
		try {
			await lockApp();
			await goto('/');
		} finally {
			busy = false;
		}
	}

	async function doClear() {
		busy = true;
		try {
			await clearAllLocal();
			confirmClear = false;
			bumpRooms();
			await goto('/');
		} finally {
			busy = false;
		}
	}
</script>

{#if hasVaultPin || hasChats}
	<section class="device" class:compact aria-label="This device">
		{#if !compact}
			<h2>This device</h2>
			<p class="lede">Chats and keys stay in this browser only. Lock or wipe them here.</p>
		{/if}
		<div class="actions">
			{#if hasVaultPin}
				<button type="button" class="secondary" disabled={busy} onclick={() => doLock()}>
					Lock app
				</button>
			{/if}
			<button
				type="button"
				class="danger"
				disabled={busy}
				onclick={() => (confirmClear = true)}
			>
				Clear all local data…
			</button>
		</div>
	</section>
{/if}

{#if confirmClear}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="modal-overlay" role="alertdialog" tabindex="-1" aria-labelledby="clear-title" onclick={() => (confirmClear = false)}>
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="modal-dialog" onclick={(e) => e.stopPropagation()}>
			<h3 id="clear-title">Clear everything on this device?</h3>
			<p class="modal-hint">
				Removes all chats, messages, saved links, and your app PIN from this browser. Relay
				servers are not notified — your partner can still have their copy.
			</p>
			<div class="modal-actions">
				<button type="button" onclick={() => (confirmClear = false)}>Cancel</button>
				<button type="button" class="danger-btn" disabled={busy} onclick={() => doClear()}>
					{busy ? 'Clearing…' : 'Clear all'}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.device {
		margin-top: 1.5rem;
		padding-top: 1.25rem;
		border-top: 1px solid var(--line);
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}

	.device.compact {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--line);
	}

	.device h2 {
		font-family: var(--font-display);
		font-size: 1rem;
		margin: 0;
	}

	.lede {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
		line-height: 1.45;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	button {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.55rem 0.85rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
	}

	button:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.secondary:hover:not(:disabled) {
		border-color: var(--accent-dim);
		color: var(--accent);
	}

	.danger {
		color: var(--danger);
		border-color: rgba(224, 107, 92, 0.35);
	}

	.danger:hover:not(:disabled) {
		background: rgba(224, 107, 92, 0.1);
	}

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
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.danger-btn {
		color: #fff;
		background: var(--danger);
		border-color: var(--danger);
	}
</style>
