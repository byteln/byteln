<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import QrScanner from '$lib/components/QrScanner.svelte';
	import ShareQr from '$lib/components/ShareQr.svelte';
	import { APP_NAME } from '$lib/brand';
	import { stashJoinPin } from '$lib/crypto/room';
	import {
		createHandoffChannel,
		HandoffError,
		handoffUrl,
		listenForHandoff,
		parseHandoffFragment,
		parseHandoffScan,
		sendHandoff,
		type HandoffChannel,
		type HandoffListener
	} from '$lib/handoff';
	import { connectionManager, roomRuntimes } from '$lib/relay/connection-manager';
	import { createSecureLine } from '$lib/rooms/start-line';
	import { defaultRelayUrl } from '$lib/servers/directory';
	import { listRooms, resolveRelayUrl, type RoomRecord } from '$lib/storage/history';
	import { bumpRooms } from '$lib/stores/conversations';
	import { onMount } from 'svelte';

	type Mode = 'receive' | 'scan' | 'send';
	type Candidate = { rec: RoomRecord; pin: string | null; partnerJoined: boolean };

	const preselect = page.url.searchParams.get('send');

	let mode = $state<Mode>('receive');

	let qrValue = $state('');
	let listenStatus = $state<'connecting' | 'open' | 'reconnecting' | 'error'>('connecting');
	let joining = $state(false);
	let listener: HandoffListener | null = null;

	let channel = $state<HandoffChannel | null>(null);
	let candidates = $state<Candidate[]>([]);
	let sendingId = $state<string | null>(null);
	let sendError = $state('');

	onMount(() => {
		const fromHash = parseHandoffFragment(location.hash);
		if (fromHash) {
			replaceState(`${location.pathname}${location.search}`, {});
			void enterSend(fromHash);
		} else if (page.url.searchParams.get('scan') === '1') {
			mode = 'scan';
		} else {
			void startReceive();
		}
		return () => listener?.close();
	});

	async function startReceive() {
		listener?.close();
		mode = 'receive';
		qrValue = '';
		const relay = await resolveRelayUrl(defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY));
		const ch = createHandoffChannel(relay);
		qrValue = handoffUrl(location.origin, ch);
		listenStatus = 'connecting';
		listener = listenForHandoff(ch, {
			onStatus: (s) => (listenStatus = s),
			onRoom: (room) => {
				listener = null;
				joining = true;
				stashJoinPin(room.bucketId, room.pin);
				void goto(`/b/${room.bucketId}${room.roomHash}`);
			}
		});
	}

	function startScan() {
		listener?.close();
		listener = null;
		mode = 'scan';
	}

	function onScan(value: string): boolean {
		const ch = parseHandoffScan(value);
		if (!ch) return false;
		void enterSend(ch);
		return true;
	}

	async function enterSend(ch: HandoffChannel) {
		channel = ch;
		mode = 'send';
		sendError = '';
		await loadCandidates();
		const pick = candidates.find(
			(c) => c.rec.bucketId === preselect && c.pin && !c.partnerJoined
		);
		if (pick) await sendRoom(pick);
	}

	async function loadCandidates() {
		const rooms = (await listRooms()).filter(
			(r) => r.isCreator && !r.legacy && r.roomHash.includes('key=')
		);
		candidates = await Promise.all(
			rooms.map(async (rec) => ({
				rec,
				pin: await connectionManager.getRoomPin(rec.bucketId),
				partnerJoined: !!rec.lastPeerDeviceFp || !!$roomRuntimes[rec.bucketId]?.peerPresent
			}))
		);
	}

	async function deliver(id: string, roomHash: string, pin: string) {
		if (!channel) return;
		await sendHandoff(channel, { bucketId: id, roomHash, pin });
		await goto(`/b/${id}${roomHash}`);
	}

	function failMessage(e: unknown): string {
		return e instanceof HandoffError ? e.message : 'Could not send to your laptop.';
	}

	async function sendRoom(c: Candidate) {
		if (!c.pin || sendingId) return;
		sendingId = c.rec.bucketId;
		sendError = '';
		try {
			await deliver(c.rec.bucketId, c.rec.roomHash, c.pin);
		} catch (e) {
			sendError = failMessage(e);
		} finally {
			sendingId = null;
		}
	}

	async function sendNewLine() {
		if (sendingId) return;
		sendingId = 'new';
		sendError = '';
		try {
			const line = await createSecureLine(undefined, 'My laptop');
			bumpRooms();
			await deliver(line.id, line.hash, line.pin);
		} catch (e) {
			sendError = failMessage(e);
			await loadCandidates();
		} finally {
			sendingId = null;
		}
	}
</script>

<svelte:head>
	<title>Link a device · {APP_NAME}</title>
</svelte:head>

<main class="handoff">
	<a href="/app?list=1" class="back">← Your chats</a>

	{#if mode === 'receive'}
		<h1>Open a chat from your phone</h1>
		<p class="lede">
			Scan this with your phone's camera, then pick the chat to open here. No copying or messaging
			apps needed.
		</p>
		{#if joining}
			<p class="status ok">Received — opening chat…</p>
		{:else if qrValue}
			<ShareQr
				value={qrValue}
				caption="Single-use code. Only the device that scans it can send a chat here."
				label="QR code to link your phone to this device"
			/>
			<p class="status" class:ok={listenStatus === 'open'}>
				{#if listenStatus === 'open'}
					Waiting for your phone…
				{:else if listenStatus === 'connecting'}
					Connecting to relay…
				{:else}
					Relay connection lost — retrying…
				{/if}
			</p>
			<div class="row">
				<button type="button" class="ghost" onclick={() => void startReceive()}>New code</button>
				<button type="button" class="ghost" onclick={startScan}>On your phone? Scan instead</button>
			</div>
		{/if}
	{:else if mode === 'scan'}
		<h1>Scan your laptop's code</h1>
		<p class="lede">On your laptop, open {APP_NAME} → Settings → Link a device.</p>
		<QrScanner {onScan} />
		<div class="row">
			<button type="button" class="ghost" onclick={() => void startReceive()}>
				Show a code on this device instead
			</button>
		</div>
	{:else}
		<h1>Send a chat to your laptop</h1>
		<p class="lede">Your laptop joins as the other person in the chat you pick.</p>

		<button
			type="button"
			class="primary"
			disabled={sendingId !== null}
			onclick={() => void sendNewLine()}
		>
			{sendingId === 'new' ? 'Sending…' : 'New chat with my laptop'}
		</button>

		{#if sendError}
			<p class="err" role="alert">{sendError}</p>
		{/if}

		{#if candidates.length}
			<h2>Or send an existing chat</h2>
			<ul class="rooms">
				{#each candidates as c (c.rec.bucketId)}
					<li>
						<div class="room-info">
							<span class="room-name">{c.rec.nickname}</span>
							<span class="room-meta">
								{#if c.partnerJoined}
									Someone already joined — no seat left for your laptop
								{:else if !c.pin}
									Room PIN not saved on this phone
								{:else}
									Waiting for a partner
								{/if}
							</span>
						</div>
						<button
							type="button"
							class="ghost"
							disabled={!c.pin || c.partnerJoined || sendingId !== null}
							onclick={() => void sendRoom(c)}
						>
							{sendingId === c.rec.bucketId ? 'Sending…' : 'Send'}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}
</main>

<style>
	.handoff {
		position: relative;
		z-index: 1;
		max-width: 26rem;
		margin: 0 auto;
		padding: 1.5rem 1.25rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 0.9rem;
	}

	.back {
		align-self: flex-start;
		font-weight: 600;
		font-size: 0.9rem;
		text-decoration: none;
	}

	h1 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.5rem;
	}

	h2 {
		margin: 0.5rem 0 0;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--muted);
	}

	.lede {
		margin: 0;
		color: var(--muted);
		line-height: 1.5;
		font-size: 0.92rem;
	}

	.status {
		margin: 0;
		text-align: center;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.status.ok {
		color: var(--accent);
	}

	.row {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 0.5rem;
	}

	.primary {
		font: inherit;
		cursor: pointer;
		border: none;
		border-radius: 0.4rem;
		padding: 0.75rem 1.1rem;
		background: var(--accent);
		color: #06110d;
		font-weight: 700;
	}

	.ghost {
		font: inherit;
		font-size: 0.85rem;
		cursor: pointer;
		border: 1px solid var(--line);
		border-radius: 0.4rem;
		padding: 0.5rem 0.85rem;
		background: transparent;
		color: var(--accent);
		font-weight: 600;
	}

	.primary:disabled,
	.ghost:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}

	.err {
		margin: 0;
		color: var(--danger);
		font-size: 0.88rem;
	}

	.rooms {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.rooms li {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.65rem 0.75rem;
		border: 1px solid var(--line);
		border-radius: 0.45rem;
		background: var(--bg1);
	}

	.room-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.room-name {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.room-meta {
		font-size: 0.78rem;
		color: var(--muted);
	}
</style>
