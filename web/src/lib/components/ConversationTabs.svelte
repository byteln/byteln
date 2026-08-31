<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { connectionManager, activeBucketId, roomRuntimes } from '$lib/relay/connection-manager';
	import { bumpRooms, roomsRevision } from '$lib/stores/conversations';
	import {
		defaultNickname,
		listRooms,
		setNickname,
		type RoomRecord
	} from '$lib/storage/history';
	import { LINE_ID_LABEL } from '$lib/brand';
	import { onMount } from 'svelte';
	import ResharePinModal from '$lib/components/ResharePinModal.svelte';

	type Props = {
		variant: 'home' | 'compact';
	};

	let { variant }: Props = $props();

	let rooms = $state<RoomRecord[]>([]);
	let editingRoom = $state<RoomRecord | null>(null);
	let editPartnerName = $state('');
	let menuPos = $state<{ bucketId: string; top: number; left: number } | null>(null);
	let forgetRoom = $state<RoomRecord | null>(null);
	let forgetWipe = $state(false);
	let reshareRoom = $state<RoomRecord | null>(null);

	const activeId = $derived($activeBucketId);

	async function loadRooms() {
		rooms = await listRooms();
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

	function connDot(bucketId: string): 'live' | 'wait' | 'off' {
		const rt = $roomRuntimes[bucketId];
		if (!rt) return 'off';
		if (rt.connState === 'open' && rt.peerPresent) return 'live';
		if (rt.connState === 'open' || rt.connState === 'connecting' || rt.connState === 'reconnecting')
			return 'wait';
		return 'off';
	}

	function roomHasPeerTraffic(bucketId: string): boolean {
		const msgs = connectionManager.getMessages(bucketId);
		return msgs.some((m) => m.from === 'peer');
	}

	function connDotForRoom(room: RoomRecord): 'live' | 'wait' | 'off' {
		const dot = connDot(room.bucketId);
		if (dot === 'live') return 'live';
		if (dot === 'wait' && roomHasPeerTraffic(room.bucketId)) return 'live';
		return dot;
	}

	async function openChat(room: RoomRecord) {
		closeMenu();
		await connectionManager.navigateToRoom(room.bucketId);
	}

	function openMenu(bucketId: string, e: MouseEvent) {
		e.stopPropagation();
		const btn = e.currentTarget as HTMLElement;
		const rect = btn.getBoundingClientRect();
		const menuWidth = variant === 'compact' ? 11.5 : 13;
		const left =
			variant === 'compact'
				? Math.max(8, Math.min(rect.left, window.innerWidth - menuWidth * 16 - 8))
				: Math.max(8, rect.right - menuWidth * 16);
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

	function startReshare(room: RoomRecord) {
		reshareRoom = room;
		closeMenu();
	}

	function closeReshare() {
		reshareRoom = null;
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
			await goto('/');
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

{#if rooms.length > 0}
	{#if variant === 'home'}
		<section class="home-list" aria-label="Your chats">
			<h2>Your chats</h2>
			<ul role="list">
				{#each rooms as room (room.bucketId)}
					<li>
						<button type="button" class="row" onclick={() => openChat(room)}>
							<span class="dot {connDotForRoom(room)}" aria-hidden="true"></span>
							<span class="main">
								<span class="name">{room.nickname}</span>
								<span class="subid" title={LINE_ID_LABEL}>{room.bucketId}</span>
								{#if room.lastPreview}
									<span class="preview">{room.lastPreview}</span>
								{/if}
							</span>
							<span class="meta">
								{#if room.unread && activeId !== room.bucketId}
									<span class="badge" aria-label="Unread">●</span>
								{/if}
								<time datetime={new Date(room.lastActiveAt).toISOString()}>
									{formatTime(room.lastActiveAt)}
								</time>
							</span>
						</button>
						<button
							type="button"
							class="menu-btn"
							aria-label="Chat options"
							aria-haspopup="menu"
							aria-expanded={menuPos?.bucketId === room.bucketId}
							onclick={(e) => openMenu(room.bucketId, e)}
						>
							⋯
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{:else}
		<div class="tab-bar-wrap">
			<div class="tab-bar" role="tablist" aria-label="Conversations">
				{#each rooms as room (room.bucketId)}
					<div class="tab-wrap" class:active={activeId === room.bucketId}>
						<button
							type="button"
							role="tab"
							class="tab"
							aria-selected={activeId === room.bucketId}
							onclick={() => openChat(room)}
						>
							<span class="dot {connDotForRoom(room)}" aria-hidden="true"></span>
							<span class="tab-label">{room.nickname}</span>
							{#if room.unread && activeId !== room.bucketId}
								<span class="badge" aria-label="Unread"></span>
							{/if}
						</button>
						<button
							type="button"
							class="tab-menu"
							aria-label="Options for {room.nickname}"
							aria-haspopup="menu"
							aria-expanded={menuPos?.bucketId === room.bucketId}
							onclick={(e) => openMenu(room.bucketId, e)}
						>
							⋯
						</button>
					</div>
				{/each}
				<button type="button" class="tab new-tab" onclick={() => goto('/')}>+ New</button>
			</div>
		</div>
	{/if}
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
			<button type="button" role="menuitem" onclick={() => startReshare(menuRoom)}>
				Reshare room PIN…
			</button>
		{/if}
		<button type="button" role="menuitem" class="danger" onclick={() => askForget(menuRoom)}>
			Forget chat…
		</button>
	</div>
{/if}

{#if reshareRoom}
	<ResharePinModal room={reshareRoom} onClose={closeReshare} />
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
	.home-list h2 {
		font-family: var(--font-display);
		font-size: 1rem;
		font-weight: 700;
		margin: 0 0 0.65rem;
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}

	.home-list ul {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.home-list li {
		display: flex;
		align-items: stretch;
		gap: 0.25rem;
	}

	.row {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		text-align: left;
		padding: 0.7rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.55);
		color: var(--ink);
		font: inherit;
		cursor: pointer;
	}

	.row:hover {
		border-color: var(--accent-dim);
	}

	.main {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.name {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.subid {
		font-family: ui-monospace, monospace;
		font-size: 0.72rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.preview {
		font-size: 0.85rem;
		color: var(--muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.25rem;
		font-size: 0.75rem;
		color: var(--muted);
		flex-shrink: 0;
	}

	.badge {
		color: var(--accent);
		font-size: 0.65rem;
	}

	.menu-btn,
	.tab-menu {
		font: inherit;
		cursor: pointer;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--muted);
		border-radius: 0.35rem;
		padding: 0 0.45rem;
		flex-shrink: 0;
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

	.tab-bar-wrap {
		flex-shrink: 0;
		margin: 0 -0.25rem;
		padding: 0 0.25rem;
	}

	.tab-bar {
		display: flex;
		gap: 0.35rem;
		overflow-x: auto;
		overflow-y: hidden;
		padding-bottom: 0.25rem;
		-webkit-overflow-scrolling: touch;
		scrollbar-width: thin;
	}

	.tab-wrap {
		display: flex;
		align-items: stretch;
		flex-shrink: 0;
	}

	.tab,
	.tab-wrap .tab-menu {
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.55);
		color: var(--muted);
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			background 0.15s ease;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		padding: 0.45rem 0.65rem;
		border-radius: 0.35rem 0 0 0.35rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		max-width: 9rem;
	}

	.tab-wrap .tab-menu {
		border-radius: 0 0.35rem 0.35rem 0;
		border-left: none;
	}

	.tab-wrap.active .tab,
	.tab-wrap.active .tab-menu {
		border-color: rgba(61, 220, 176, 0.45);
		background: rgba(18, 26, 23, 0.72);
		color: var(--ink);
	}

	.tab-wrap.active .tab {
		box-shadow: inset 0 -2px 0 var(--accent);
	}

	.tab:hover,
	.tab-wrap .tab-menu:hover {
		border-color: rgba(61, 220, 176, 0.3);
		color: var(--ink);
	}

	.tab-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.new-tab {
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.55);
		color: var(--accent);
		flex-shrink: 0;
		padding: 0.45rem 0.65rem;
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
	}

	.tab .badge {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
	}

	.dot {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--muted);
		opacity: 0.5;
	}

	.dot.live {
		background: var(--accent);
		opacity: 1;
	}

	.dot.wait {
		background: var(--accent);
		opacity: 0.45;
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
