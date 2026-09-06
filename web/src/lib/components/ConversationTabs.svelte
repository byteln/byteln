<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { connectionManager, activeBucketId, roomRuntimes, messagesByBucket } from '$lib/relay/connection-manager';
	import { bumpRooms, roomsRevision } from '$lib/stores/conversations';
	import {
		defaultNickname,
		listRooms,
		setNickname,
		type RoomRecord
	} from '$lib/storage/history';
	import { LINE_ID_LABEL } from '$lib/brand';
	import { onMount } from 'svelte';
	import ShareInviteModal from '$lib/components/ShareInviteModal.svelte';

	type Props = {
		variant: 'home' | 'sheet';
		onSelect?: () => void;
	};

	let { variant, onSelect }: Props = $props();

	let rooms = $state<RoomRecord[]>([]);
	let loaded = $state(false);
	let editingRoom = $state<RoomRecord | null>(null);
	let editPartnerName = $state('');
	let menuPos = $state<{ bucketId: string; top: number; left: number } | null>(null);
	let forgetRoom = $state<RoomRecord | null>(null);
	let forgetWipe = $state(false);
	let shareRoom = $state<RoomRecord | null>(null);

	const activeId = $derived($activeBucketId);

	async function loadRooms() {
		rooms = await listRooms();
		loaded = true;
	}

	onMount(() => {
		void loadRooms();
		const unsub = roomsRevision.subscribe(() => {
			void loadRooms();
		});
		return unsub;
	});

	function formatTime(ts: number): string {
		const d = new Date(ts);
		const now = new Date();
		if (d.toDateString() === now.toDateString()) {
			return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
		}
		return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
	}

	function connDot(bucketId: string): 'live' | 'wait' | 'reconnecting' | 'off' {
		const rt = $roomRuntimes[bucketId];
		if (!rt) return 'off';
		if (rt.connState === 'open' && rt.peerPresent) return 'live';
		if (rt.connState === 'reconnecting') return 'reconnecting';
		if (rt.connState === 'open' || rt.connState === 'connecting') return 'wait';
		return 'off';
	}

	function connDotForRoom(room: RoomRecord): 'live' | 'wait' | 'reconnecting' | 'off' {
		const dot = connDot(room.bucketId);
		if (dot === 'live') return 'live';
		if (dot === 'reconnecting') return 'reconnecting';
		if (dot === 'wait' && roomHasPeerTraffic(room.bucketId)) return 'live';
		return dot;
	}

	function roomHasPeerTraffic(bucketId: string): boolean {
		const msgs = $messagesByBucket[bucketId] ?? [];
		return msgs.some((m) => m.from === 'peer');
	}

	async function openChat(room: RoomRecord) {
		closeMenu();
		await connectionManager.navigateToRoom(room.bucketId);
		onSelect?.();
	}

	function openMenu(bucketId: string, e: MouseEvent) {
		e.stopPropagation();
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		const menuWidth = 13;
		const left = Math.max(8, rect.right - menuWidth * 16);
		menuPos = { bucketId, top: rect.bottom + 4, left };
	}

	function closeMenu() {
		menuPos = null;
	}

	function startRename(room: RoomRecord) {
		editingRoom = room;
		editPartnerName = room.nickname;
		closeMenu();
	}

	async function commitRename() {
		if (!editingRoom) return;
		const bucketId = editingRoom.bucketId;
		const partner = editPartnerName.trim() || defaultNickname(bucketId);
		await setNickname(bucketId, partner);
		editingRoom = null;
		bumpRooms();
		await loadRooms();
	}

	function cancelRename() {
		editingRoom = null;
		editPartnerName = '';
	}

	function askForget(room: RoomRecord) {
		forgetRoom = room;
		forgetWipe = false;
		closeMenu();
	}

	function startShare(room: RoomRecord) {
		shareRoom = room;
		closeMenu();
	}

	function closeShare() {
		shareRoom = null;
	}

	async function confirmForget() {
		if (!forgetRoom) return;
		const bucketId = forgetRoom.bucketId;
		const leaveChat = page.url.pathname === `/b/${bucketId}`;
		await connectionManager.forgetRoom(bucketId, forgetWipe);
		forgetRoom = null;
		forgetWipe = false;
		await loadRooms();
		bumpRooms();
		if (leaveChat) {
			await goto('/app');
		}
	}

	function cancelForget() {
		forgetRoom = null;
		forgetWipe = false;
	}

	function onDocClick() {
		closeMenu();
	}

	const menuRoom = $derived(rooms.find((r) => r.bucketId === menuPos?.bucketId));
</script>

<svelte:window onclick={onDocClick} />

{#snippet chatListBody()}
	{#if loaded && rooms.length === 0}
		<div class="empty-state">
			<svg width="40" height="24" viewBox="0 0 40 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<line x1="8" y1="12" x2="32" y2="12" stroke="#232830" stroke-width="1.5" />
				<circle cx="8" cy="12" r="5" fill="#090B0D" stroke="#34D399" stroke-width="2" />
				<circle cx="32" cy="12" r="5" fill="#090B0D" stroke="#34D399" stroke-width="2" />
			</svg>
			<p>No lines yet. Start one below, or open a link someone sent you.</p>
		</div>
	{:else if rooms.length > 0}
		<ul class="chat-list" role="list">
			{#each rooms as room (room.bucketId)}
				<li class="chat-row" class:active={activeId === room.bucketId}>
					<button type="button" class="chat-open" onclick={() => openChat(room)}>
						<span class={['chat-status', connDotForRoom(room)]} aria-hidden="true"></span>
						<span class="chat-main">
							<span class="chat-top-row">
								<span class="chat-name">{room.nickname}</span>
								<time class="chat-time" datetime={new Date(room.lastActiveAt).toISOString()}>
									{formatTime(room.lastActiveAt)}
								</time>
							</span>
							<span class="chat-preview">
								<span class="chat-id" title={LINE_ID_LABEL}>{room.bucketId}</span>
								{#if room.lastPreview}
									· {room.lastPreview}
								{/if}
								{#if room.unread && activeId !== room.bucketId}
									<span class="unread" aria-label="Unread">●</span>
								{/if}
							</span>
						</span>
					</button>
					<button
						type="button"
						class="chat-more"
						aria-label="Line options"
						aria-haspopup="menu"
						aria-expanded={menuPos?.bucketId === room.bucketId}
						onclick={(e) => openMenu(room.bucketId, e)}
					>
						<svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
							<circle cx="10" cy="4" r="1.5" fill="currentColor" />
							<circle cx="10" cy="10" r="1.5" fill="currentColor" />
							<circle cx="10" cy="16" r="1.5" fill="currentColor" />
						</svg>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#if variant === 'home'}
	<section class="home-list" aria-label="Your chats">
		<h2 class="list-label">Your chats</h2>
		{@render chatListBody()}
	</section>
{:else}
	<section class="sheet-list" aria-label="Your chats">
		{@render chatListBody()}
	</section>
{/if}

{#if menuPos && menuRoom}
	<div
		class="menu-portal"
		style:top="{menuPos.top}px"
		style:left="{menuPos.left}px"
		role="menu"
		tabindex="-1"
		onclick={(e) => e.stopPropagation()}
		onkeydown={(e) => e.stopPropagation()}
	>
		<button type="button" role="menuitem" onclick={() => startRename(menuRoom)}>Rename partner</button>
		{#if menuRoom.isCreator && !menuRoom.legacy}
			<button type="button" role="menuitem" onclick={() => startShare(menuRoom)}>
				Share…
			</button>
		{/if}
		<button type="button" role="menuitem" class="danger" onclick={() => askForget(menuRoom)}>
			Forget chat…
		</button>
	</div>
{/if}

{#if shareRoom}
	<ShareInviteModal room={shareRoom} onClose={closeShare} />
{/if}

{#if editingRoom}
	<div class="modal-overlay">
		<button type="button" class="modal-scrim" aria-label="Close dialog" onclick={cancelRename}></button>
		<div
			class="modal-dialog"
			role="dialog"
			aria-modal="true"
			aria-labelledby="rename-title"
			tabindex="-1"
			onkeydown={(e) => e.key === 'Escape' && cancelRename()}
		>
			<h3 id="rename-title">Rename partner</h3>
			<p class="modal-hint">Only you see this name — it stays on this device.</p>
			<label class="field">
				<span>Partner name</span>
				<input
					type="text"
					bind:value={editPartnerName}
					maxlength="64"
					placeholder="How you remember them"
					onkeydown={(e) => {
						if (e.key === 'Enter') void commitRename();
						if (e.key === 'Escape') cancelRename();
					}}
				/>
			</label>
			<div class="modal-actions">
				<button type="button" onclick={cancelRename}>Cancel</button>
				<button type="button" class="primary" onclick={() => commitRename()}>Save</button>
			</div>
		</div>
	</div>
{/if}

{#if forgetRoom}
	<div class="modal-overlay">
		<button type="button" class="modal-scrim" aria-label="Close dialog" onclick={cancelForget}></button>
		<div
			class="modal-dialog"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="forget-title"
			tabindex="-1"
			onkeydown={(e) => e.key === 'Escape' && cancelForget()}
		>
			<h3 id="forget-title">Forget “{forgetRoom.nickname}”?</h3>
			<p class="modal-hint">Removes this chat from your list on this device. The relay is not notified.</p>
			<label class="check">
				<input type="checkbox" bind:checked={forgetWipe} />
				Also delete local messages for this chat
			</label>
			<div class="modal-actions">
				<button type="button" onclick={cancelForget}>Cancel</button>
				<button type="button" class="danger-btn" onclick={() => confirmForget()}>Forget chat</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.list-label {
		font-family: inherit;
		font-size: 12.5px;
		color: var(--dim, var(--muted));
		font-weight: 500;
		margin: 0 0 10px;
		padding: 0 2px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.sheet-list .chat-list {
		margin-bottom: 0;
	}

	.sheet-list .empty-state {
		margin-bottom: 0;
	}

	.chat-list {
		list-style: none;
		margin: 0 0 28px;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.chat-row {
		display: flex;
		align-items: center;
		gap: 4px;
		background: var(--surface, rgba(18, 26, 23, 0.55));
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 4px 4px 4px 14px;
	}

	.chat-row:active {
		background: var(--surface-2, #171b21);
	}

	.chat-row.active {
		border-color: rgba(61, 220, 176, 0.45);
		background: rgba(61, 220, 176, 0.08);
		box-shadow: inset 0 0 0 1px rgba(61, 220, 176, 0.12);
	}

	.chat-open {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 12px;
		text-align: left;
		padding: 10px 0;
		border: none;
		background: none;
		color: inherit;
		font: inherit;
		cursor: pointer;
	}

	.chat-status {
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--dim, var(--muted));
		flex-shrink: 0;
	}

	.chat-status.live {
		background: #3ddcb0;
		box-shadow: 0 0 0 3px rgba(61, 220, 176, 0.28);
	}

	.chat-status.wait {
		background: #5b9cff;
		opacity: 1;
	}

	.chat-status.reconnecting {
		background: #ffc14d;
		animation: dot-pulse 1.4s ease-in-out infinite;
	}

	.chat-status.off {
		background: var(--dim, var(--muted));
	}

	.chat-main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.chat-top-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.chat-name {
		font-size: 15.5px;
		font-weight: 600;
		color: var(--text, var(--ink));
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chat-time {
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		font-size: 11.5px;
		color: var(--dim, var(--muted));
		flex-shrink: 0;
	}

	.chat-preview {
		font-size: 13.5px;
		color: var(--muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.chat-id {
		font-family: 'IBM Plex Mono', ui-monospace, monospace;
		color: var(--dim, var(--muted));
	}

	.unread {
		color: var(--accent);
		font-size: 0.7rem;
		margin-left: 0.2rem;
	}

	.chat-more {
		flex-shrink: 0;
		width: 40px;
		height: 40px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--dim, var(--muted));
		border: none;
		background: none;
		border-radius: 8px;
		cursor: pointer;
		padding: 0;
	}

	.chat-more:active {
		background: var(--surface-2, #171b21);
	}

	.empty-state {
		text-align: center;
		padding: 40px 20px;
		border: 1px dashed var(--line);
		border-radius: 14px;
		margin-bottom: 28px;
	}

	.empty-state svg {
		margin-bottom: 14px;
	}

	.empty-state p {
		font-size: 14px;
		color: var(--muted);
		margin: 0;
		line-height: 1.6;
	}

	.menu-portal {
		position: fixed;
		z-index: 200;
		min-width: 11.5rem;
		background: var(--bg1);
		border: 1px solid var(--line);
		border-radius: 0.35rem;
		padding: 0.35rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
	}

	.menu-portal button {
		font: inherit;
		text-align: left;
		padding: 0.5rem 0.65rem;
		border: none;
		background: transparent;
		color: var(--ink);
		border-radius: 0.25rem;
		cursor: pointer;
		white-space: nowrap;
	}

	.menu-portal button:hover {
		background: rgba(61, 220, 176, 0.1);
	}

	.menu-portal .danger {
		color: var(--danger);
	}

	@keyframes dot-pulse {
		0%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
		50% {
			opacity: 0.45;
			transform: scale(0.85);
		}
	}

	.modal-overlay {
		position: fixed;
		inset: 0;
		z-index: 300;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}

	.modal-scrim {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		margin: 0;
		background: rgba(0, 0, 0, 0.55);
		cursor: default;
	}

	.modal-dialog {
		position: relative;
		z-index: 1;
		background: var(--bg1);
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		padding: 1.25rem;
		width: min(100%, 24rem);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.modal-dialog h3 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
	}

	.modal-hint {
		margin: 0;
		color: var(--muted);
		font-size: 0.88rem;
		line-height: 1.45;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
	}

	.field span {
		color: var(--muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.field input {
		font: inherit;
		padding: 0.65rem 0.75rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
	}

	.check {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		font-size: 0.9rem;
		color: var(--muted);
		cursor: pointer;
	}

	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}

	.modal-actions button {
		font: inherit;
		padding: 0.5rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
		cursor: pointer;
	}

	.modal-actions .primary {
		background: var(--accent);
		color: #06110d;
		border: none;
		font-weight: 600;
	}

	.modal-actions .danger-btn {
		border-color: var(--danger);
		color: var(--danger);
		font-weight: 600;
	}
</style>
