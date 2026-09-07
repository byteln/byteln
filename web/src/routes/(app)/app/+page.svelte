<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import AppSettings from '$lib/components/AppSettings.svelte';
	import ChatListSidePanel from '$lib/components/ChatListSidePanel.svelte';
	import { APP_NAME } from '$lib/brand';
	import { startSecureLine } from '$lib/rooms/start-line';
	import { roomsRevision } from '$lib/stores/conversations';
	import { listRooms, type RoomRecord } from '$lib/storage/history';
	import { onMount } from 'svelte';

	let rooms = $state<RoomRecord[]>([]);
	let settingsOpen = $state(false);
	let busy = $state(false);
	let booting = $state(true);

	async function refreshRooms() {
		rooms = await listRooms();
	}

	onMount(() => {
		void (async () => {
			await refreshRooms();

			const createIntent =
				page.url.searchParams.get('create') === '1' || page.url.searchParams.get('new') === '1';
			if (createIntent) {
				const url = new URL(page.url);
				url.searchParams.delete('create');
				url.searchParams.delete('new');
				history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
				busy = true;
				try {
					await startSecureLine();
				} finally {
					busy = false;
					booting = false;
				}
				return;
			}

			if (rooms.length > 0) {
				const latest = rooms[0];
				if (latest) {
					await goto(`/b/${latest.bucketId}${latest.roomHash || ''}`);
					return;
				}
			}

			// No lines — stay on empty hub (create from here or settings).
			booting = false;
		})();

		const unsub = roomsRevision.subscribe(() => {
			void refreshRooms();
		});
		return unsub;
	});

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

<svelte:head>
	<title>{APP_NAME}</title>
</svelte:head>

{#if booting}
	<main class="hub boot">
		<p>Opening…</p>
	</main>
{:else}
	<main class="hub">
		<div class="chat-shell">
			<aside class="chat-sidebar" aria-label="Your chats">
				<ChatListSidePanel />
			</aside>

			<div class="chat-main">
				<header>
					<span class="brand">{APP_NAME}</span>
					<div class="presence">
						<span class="presence-title">Get started</span>
						<span class="presence-hint">Create a line or import history from settings.</span>
					</div>
					<button
						type="button"
						class="gear-btn"
						aria-label="Settings"
						title="Settings"
						onclick={() => (settingsOpen = true)}
					>
						<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
							<path
								d="M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z"
								stroke="currentColor"
								stroke-width="1.75"
							/>
							<path
								d="M19.4 13a7.6 7.6 0 000-2l2-1.2-2-3.4-2.3.6a7.7 7.7 0 00-1.7-1L15 3.5h-4l-.4 2.5a7.7 7.7 0 00-1.7 1L6.6 6.4l-2 3.4 2 1.2a7.6 7.6 0 000 2l-2 1.2 2 3.4 2.3-.6a7.7 7.7 0 001.7 1l.4 2.5h4l.4-2.5a7.7 7.7 0 001.7-1l2.3.6 2-3.4-2-1.2z"
								stroke="currentColor"
								stroke-width="1.75"
								stroke-linejoin="round"
							/>
						</svg>
					</button>
				</header>

				<div class="empty-pane">
					<p class="empty-title">No secure lines yet</p>
					<p class="empty-lede">
						Start a new line to get a link and PIN for your partner. Import is in settings if you
						have a backup.
					</p>
					<button type="button" class="primary" disabled={busy} onclick={() => void newLine()}>
						{busy ? 'Opening…' : 'New secure line'}
					</button>
					<button type="button" class="ghost" onclick={() => (settingsOpen = true)}>Settings</button>
				</div>
			</div>
		</div>
	</main>

	<AppSettings open={settingsOpen} onClose={() => (settingsOpen = false)} />
{/if}

<style>
	.hub {
		position: relative;
		z-index: 1;
		max-width: 48rem;
		margin: 0 auto;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		padding: 1rem 1rem 0;
		gap: 0.75rem;
		overflow: hidden;
		color: var(--ink);
	}

	.hub.boot {
		align-items: center;
		justify-content: center;
		color: var(--muted);
	}

	@media (min-width: 720px) {
		.hub {
			max-width: min(72rem, 100%);
			padding: 1rem 1.25rem 0;
		}
	}

	.chat-shell {
		display: flex;
		flex: 1;
		min-height: 0;
		gap: 0.75rem;
	}

	.chat-sidebar {
		display: none;
		width: 17rem;
		flex-shrink: 0;
		min-height: 0;
		overflow: hidden;
		border-radius: 0.5rem;
	}

	@media (min-width: 720px) {
		.chat-sidebar {
			display: flex;
			flex-direction: column;
		}
	}

	.chat-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0;
		overflow: hidden;
	}

	header {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
	}

	.brand {
		font-family: var(--font-display);
		font-weight: 700;
		color: var(--accent);
		text-decoration: none;
		flex-shrink: 0;
	}

	.presence {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
	}

	.presence-title {
		font-weight: 600;
		font-size: 0.95rem;
	}

	.presence-hint {
		font-size: 0.78rem;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.gear-btn {
		flex-shrink: 0;
		width: 2.25rem;
		height: 2.25rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--line);
		border-radius: 0.4rem;
		background: transparent;
		color: var(--muted);
		cursor: pointer;
		padding: 0;
	}

	.gear-btn:hover {
		color: var(--ink);
		border-color: rgba(61, 220, 176, 0.35);
	}

	.empty-pane {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 0.75rem;
		text-align: center;
		padding: 1.5rem;
	}

	.empty-title {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 600;
	}

	.empty-lede {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
		max-width: 28ch;
		line-height: 1.45;
	}

	.primary {
		font: inherit;
		cursor: pointer;
		border: none;
		border-radius: 0.4rem;
		padding: 0.7rem 1.1rem;
		background: var(--accent);
		color: #06110d;
		font-weight: 700;
	}

	.primary:disabled {
		opacity: 0.65;
		cursor: wait;
	}

	.ghost {
		font: inherit;
		cursor: pointer;
		border: 1px solid var(--line);
		border-radius: 0.4rem;
		padding: 0.55rem 0.9rem;
		background: transparent;
		color: var(--accent);
		font-weight: 600;
	}
</style>
