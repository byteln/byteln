<script lang="ts">
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import AppSettings from '$lib/components/AppSettings.svelte';
	import ChatListSheet from '$lib/components/ChatListSheet.svelte';
	import ChatListSidePanel from '$lib/components/ChatListSidePanel.svelte';
	import DeviceSettings from '$lib/components/DeviceSettings.svelte';
	import ShareInviteModal from '$lib/components/ShareInviteModal.svelte';
	import ShareQr from '$lib/components/ShareQr.svelte';
	import {
		exportHistory,
		exportHistoryWithPassphraseOnly,
		type StoredMessage
	} from '$lib/crypto/backup';
	import {
		parseRoomFragment,
		sanitizeRoomFragmentInput,
		shareRoomHash,
		takeCreatorPin,
		type RoomFragment
	} from '$lib/crypto/room';
	import { importKeyRaw, randomToken } from '$lib/crypto/session';
	import {
		browserOffline,
		connectionManager,
		messagesByBucket,
		roomRuntimes
	} from '$lib/relay/connection-manager';
	import {
		ensureNotifyPermission,
		getNotifyPermission,
		type NotifyPermission
	} from '$lib/notify';
	import { defaultRelayUrl } from '$lib/servers/directory';
	import {
		defaultNickname,
		getRoom,
		getSessionToken,
		listMessages,
		listRooms,
		resolveRelayUrl,
		setNickname,
		setSessionToken,
		type RoomRecord
	} from '$lib/storage/history';
	import { APP_NAME, LINE_ID_LABEL, partnerDisplayName, SECURE_LINE } from '$lib/brand';
	import { inviteText, shareInvite } from '$lib/share';
	import { bumpRooms, roomsRevision } from '$lib/stores/conversations';
	import { onMount, tick } from 'svelte';

	const bucketId = $derived(page.params.id ?? '');
	const SCROLL_THRESHOLD = 72;
	const CHATS_SHEET_MAX_WIDTH = 720;

	type Phase = 'loading' | 'creator_share' | 'line_pin' | 'chat';

	let key = $state<CryptoKey | null>(null);
	let room = $state<RoomFragment | null>(null);
	let phase = $state<Phase>('loading');
	let creatorPin = $state('');
	let pinInput = $state('');
	let pinError = $state('');
	let nickname = $state('');
	let editNickname = $state('');
	let draft = $state('');
	let error = $state('');
	let relayUrl = $state('');
	let copiedKind = $state<'link' | 'pin' | 'both' | null>(null);
	let shareBusy = $state<'qr' | 'invite' | null>(null);
	let shareFlash = $state<'qr' | 'invite' | null>(null);
	let exportPass = $state('');
	let passOnly = $state(false);
	let reportNote = $state('');
	let notifyPerm = $state<NotifyPermission>('unsupported');
	let infoOpen = $state(false);
	let pinnedToBottom = $state(true);
	let showNicknamePrompt = $state(false);
	let reconnectBusy = $state(false);
	let legacyMode = $state(false);
	let isCreator = $state(false);
	let chatsOpen = $state(false);
	let settingsOpen = $state(false);
	let shareRoom = $state<RoomRecord | null>(null);
	let rooms = $state<RoomRecord[]>([]);

	let listEl = $state<HTMLElement | null>(null);

	const messages = $derived(($messagesByBucket[bucketId] ?? []) as StoredMessage[]);
	const runtime = $derived($roomRuntimes[bucketId]);
	const connState = $derived(runtime?.connState ?? 'connecting');
	const connDetail = $derived(runtime?.connDetail ?? '');
	const reconnectAttempt = $derived(runtime?.reconnectAttempt ?? 0);
	const reconnectStalled = $derived(runtime?.reconnectStalled ?? false);
	const offline = $derived($browserOffline);
	const peerPresent = $derived(runtime?.peerPresent ?? false);
	const partnerConnected = $derived(
		peerPresent || messages.some((m) => m.from === 'peer')
	);
	const bucketFull = $derived(runtime?.bucketFull ?? false);
	const partnerLabelText = $derived(partnerDisplayName(nickname, bucketId));

	const showScrollDown = $derived(!pinnedToBottom && messages.length > 0);
	const hasOtherUnread = $derived(
		rooms.some((r) => r.unread && r.bucketId !== bucketId)
	);

	$effect(() => {
		if (phase !== 'chat') return;
		const lastId = messages.at(-1)?.id;
		if (!lastId || !pinnedToBottom) return;
		void tick().then(() => {
			if (!listEl || !pinnedToBottom) return;
			listEl.scrollTo({ top: listEl.scrollHeight, behavior: 'auto' });
		});
	});

	const presenceLabel = $derived.by(() => {
		if (phase !== 'chat') return 'Enter room PIN';
		if (offline) return 'Offline';
		if (connState === 'connecting') return 'Connecting…';
		if (connState === 'reconnecting') {
			return reconnectAttempt > 1 ? `Reconnecting… (${reconnectAttempt})` : 'Reconnecting…';
		}
		if (reconnectStalled || connState === 'error') return 'Connection lost';
		if (connState === 'closed') return 'Disconnected';
		return partnerConnected ? `${partnerLabelText} connected` : `Waiting for ${partnerLabelText}`;
	});

	const presenceWaiting = $derived(
		phase === 'chat' &&
			!offline &&
			connState === 'open' &&
			!partnerConnected &&
			!reconnectStalled
	);

	const presenceHint = $derived.by(() => {
		if (phase === 'creator_share') return 'Share the link and PIN with your partner separately.';
		if (phase === 'line_pin') return 'The PIN is not in the link — ask whoever invited you.';
		if (offline) return 'Waiting for network — will retry when you are back online.';
		if (connState === 'open' && partnerConnected) return `${partnerLabelText} is in this chat.`;
		if (connState === 'open' && isCreator) return 'Share the link and room PIN with your partner.';
		if (connState === 'open') return `Connected — waiting for ${partnerLabelText} to join.`;
		if (connState === 'reconnecting') return 'Restoring your secure connection automatically.';
		if (reconnectStalled) return 'Automatic retry stopped — tap Reconnect below.';
		if (connState === 'connecting') return 'Opening a secure channel to the relay.';
		if (connState === 'closed' || connState === 'error') return 'Trying to restore your connection.';
		return 'Opening a secure channel to the relay.';
	});

	const showConnBanner = $derived(
		phase === 'chat' &&
			(offline ||
				reconnectStalled ||
				connState === 'reconnecting' ||
				connState === 'closed' ||
				connState === 'error')
	);

	function updateScrollPin() {
		if (!listEl) return;
		const { scrollTop, scrollHeight, clientHeight } = listEl;
		pinnedToBottom = scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
	}

	function scrollToBottom(force = false) {
		if (!listEl) return;
		if (!force && !pinnedToBottom) return;
		listEl.scrollTo({ top: listEl.scrollHeight, behavior: force ? 'smooth' : 'auto' });
		pinnedToBottom = true;
	}

	function openChatsSheet() {
		if (typeof window !== 'undefined' && window.innerWidth >= CHATS_SHEET_MAX_WIDTH) return;
		chatsOpen = true;
	}

	function onWindowResize() {
		if (chatsOpen && window.innerWidth >= CHATS_SHEET_MAX_WIDTH) {
			chatsOpen = false;
		}
	}

	async function loadRoomMeta() {
		const rec = await getRoom(bucketId);
		nickname = rec?.nickname ?? defaultNickname(bucketId);
		editNickname = nickname;
		isCreator = rec?.isCreator === true || (rec?.isCreator !== false && room?.seat === 0);
	}

	async function loadNames() {
		await loadRoomMeta();
	}

	async function enterChatPhase(promptName = false) {
		phase = 'chat';
		if (promptName) {
			const rec = await getRoom(bucketId);
			if (!rec || rec.nickname === defaultNickname(bucketId)) {
				showNicknamePrompt = true;
				editNickname = nickname;
			}
		}
		queueMicrotask(() => scrollToBottom(true));
	}

	async function connectLegacy() {
		if (!room) return;
		let token = await getSessionToken(bucketId);
		if (!token) {
			token = randomToken();
			await setSessionToken(bucketId, token);
		}
		await connectionManager.registerRoom({
			bucketId,
			roomHash: location.hash,
			relayUrl,
			legacy: true,
			legacyToken: token,
			isCreator: room.seat === 0
		});
		await connectionManager.openRoom(bucketId);
		await enterChatPhase(true);
	}

	async function connectWithPin(pin: string) {
		if (!room || room.legacy || !key) return;
		pinError = '';
		const ok = await connectionManager.connectWithPin(bucketId, pin, location.hash, relayUrl);
		if (!ok) {
			if (connectionManager.getRuntime(bucketId)?.bucketFull) {
				phase = 'chat';
				return;
			}
			pinError = 'Wrong room PIN. Check with whoever shared the link.';
			return;
		}
		await loadRoomMeta();
		await enterChatPhase(true);
	}

	async function submitPin() {
		const pin = pinInput.trim();
		if (!/^\d{6}$/.test(pin)) {
			pinError = 'Enter the 6-digit room PIN.';
			return;
		}
		await connectWithPin(pin);
	}

	async function continueFromCreatorModal() {
		if (!creatorPin) return;
		pinInput = creatorPin;
		await connectWithPin(creatorPin);
	}

	async function savePartnerName() {
		const partner = editNickname.trim() || defaultNickname(bucketId);
		await setNickname(bucketId, partner);
		nickname = partner;
		showNicknamePrompt = false;
		bumpRooms();
	}

	let bootGen = 0;

	function resetRoomUi() {
		phase = 'loading';
		key = null;
		room = null;
		creatorPin = '';
		pinInput = '';
		pinError = '';
		error = '';
		draft = '';
		legacyMode = false;
		isCreator = false;
		showNicknamePrompt = false;
		infoOpen = false;
		copiedKind = null;
		shareBusy = null;
		shareFlash = null;
		pinnedToBottom = true;
		nickname = '';
		editNickname = '';
	}

	async function bootstrapRoom(id: string, gen: number) {
		try {
			await connectionManager.setActive(id);
			if (gen !== bootGen) return;
			await loadNames();
			if (gen !== bootGen) return;

			let hash = location.hash;
			if (!hash.includes('key=')) {
				const rec = await getRoom(id);
				const creds = await connectionManager.getRoomCredentials(id);
				if (gen !== bootGen) return;
				hash = creds?.roomHash || rec?.roomHash || '';
				if (hash && !hash.startsWith('#')) hash = `#${hash}`;
				if (hash.includes('key=')) {
					history.replaceState(null, '', `${location.pathname}${hash}`);
				}
			}

			const { hash: cleanHash, pinHint } = sanitizeRoomFragmentInput(hash);
			if (cleanHash.includes('key=')) {
				hash = cleanHash;
				history.replaceState(null, '', `${location.pathname}${hash}`);
			}
			if (pinHint) pinInput = pinHint;

			const parsed = parseRoomFragment(hash);
			if (!parsed) {
				error = 'Missing #key= in the URL. Ask the creator for the full share link.';
				return;
			}
			room = parsed;
			key = await importKeyRaw(parsed.keyRaw);
			if (gen !== bootGen) return;
			history.replaceState(null, '', `${location.pathname}${hash}`);

			const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
			relayUrl = await resolveRelayUrl(fallback);
			if (gen !== bootGen) return;

			if (!connectionManager.isOpen(id)) {
				const msgs = await listMessages(id);
				if (gen !== bootGen) return;
				messagesByBucket.update((m) => ({ ...m, [id]: msgs }));
			}

			if (parsed.legacy) {
				legacyMode = true;
				await connectLegacy();
				if (gen !== bootGen) return;
				await ensureRoomRegistered(parsed);
				return;
			}

			const once = takeCreatorPin(id);
			if (once) {
				creatorPin = once;
				isCreator = true;
				phase = 'creator_share';
				await ensureRoomRegistered(parsed);
				return;
			}

			const rt = connectionManager.getRuntime(id);
			if (rt?.bucketFull) {
				phase = 'chat';
				await loadRoomMeta();
				return;
			}

			const opened = await connectionManager.openRoom(id);
			if (gen !== bootGen) return;
			if (opened) {
				await ensureRoomRegistered(parsed);
				if (gen !== bootGen) return;
				await loadRoomMeta();
				await enterChatPhase(false);
				return;
			}

			if (connectionManager.getRuntime(id)?.bucketFull) {
				phase = 'chat';
				return;
			}

			await ensureRoomRegistered(parsed);
			if (gen !== bootGen) return;
			if (pinHint && /^\d{6}$/.test(pinHint)) {
				await connectWithPin(pinHint);
				return;
			}
			phase = 'line_pin';
		} catch (e) {
			if (gen !== bootGen) return;
			error = e instanceof Error ? e.message : 'failed to start';
		}
	}

	$effect(() => {
		const id = bucketId;
		if (!id) return;
		const gen = ++bootGen;
		resetRoomUi();
		void bootstrapRoom(id, gen);
	});

	async function loadRoomsForBadge() {
		rooms = await listRooms();
	}

	onMount(() => {
		notifyPerm = getNotifyPermission();
		void loadRoomsForBadge();
		const unsubNames = roomsRevision.subscribe(() => {
			void loadNames();
			void loadRoomsForBadge();
		});
		return unsubNames;
	});

	async function ensureRoomRegistered(parsed: RoomFragment) {
		const rec = await getRoom(bucketId);
		if (rec?.roomHash?.includes('key=')) return;
		const creds = await connectionManager.getRoomCredentials(bucketId);
		await connectionManager.registerRoom({
			bucketId,
			roomHash: location.hash,
			relayUrl,
			roomPin: creds?.roomPin,
			legacy: parsed.legacy,
			isCreator: parsed.seat === 0 ? true : false
		});
	}

	async function enableNotifications() {
		notifyPerm = await ensureNotifyPermission();
	}

	async function openShare() {
		const rec = await getRoom(bucketId);
		if (!rec || !rec.isCreator || rec.legacy) return;
		shareRoom = rec;
	}

	async function send() {
		const body = draft.trim();
		if (!body || !key || connState !== 'open') return;
		const ok = await connectionManager.send(bucketId, body);
		if (!ok) return;
		draft = '';
		queueMicrotask(() => scrollToBottom(true));
	}

	function shareUrl(): string {
		return `${location.origin}/b/${bucketId}${shareRoomHash(location.hash)}`;
	}

	function flashCopied(kind: 'link' | 'pin' | 'both') {
		copiedKind = kind;
		setTimeout(() => {
			if (copiedKind === kind) copiedKind = null;
		}, 1500);
	}

	async function copyCreatorLink() {
		await navigator.clipboard.writeText(shareUrl());
		flashCopied('link');
	}

	async function copyCreatorPinOnly() {
		if (!creatorPin) return;
		await navigator.clipboard.writeText(creatorPin);
		flashCopied('pin');
	}

	async function copyCreatorShare() {
		if (!creatorPin) {
			await copyCreatorLink();
			return;
		}
		await navigator.clipboard.writeText(inviteText(shareUrl(), creatorPin));
		flashCopied('both');
	}

	function flashShare(kind: 'qr' | 'invite') {
		shareFlash = kind;
		setTimeout(() => {
			if (shareFlash === kind) shareFlash = null;
		}, 1500);
	}

	async function shareCreatorQr() {
		if (shareBusy) return;
		shareBusy = 'qr';
		try {
			const result = await shareInvite({
				url: shareUrl(),
				pin: creatorPin || undefined,
				withQr: true,
				qrFilename: `byteln-${bucketId}-qr.png`
			});
			if (result !== 'cancelled') flashShare('qr');
		} finally {
			shareBusy = null;
		}
	}

	async function shareCreatorInvite() {
		if (!creatorPin || shareBusy) return;
		shareBusy = 'invite';
		try {
			const result = await shareInvite({
				url: shareUrl(),
				pin: creatorPin,
				withQr: false
			});
			if (result !== 'cancelled') flashShare('invite');
		} finally {
			shareBusy = null;
		}
	}

	async function doExport() {
		if (!key) return;
		let file;
		if (passOnly && exportPass) {
			file = await exportHistoryWithPassphraseOnly(bucketId, messages, exportPass);
		} else {
			file = await exportHistory(bucketId, key, messages, exportPass || undefined);
		}
		const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = `byteln-${bucketId}.json`;
		a.click();
		URL.revokeObjectURL(a.href);
	}

	function reportLine() {
		const subject = encodeURIComponent(`${APP_NAME} report: ${bucketId}`);
		const body = encodeURIComponent(
			`${LINE_ID_LABEL}: ${bucketId}\nNote: ${reportNote || '(none)'}\n\nNo message content included.`
		);
		location.href = `mailto:?subject=${subject}&body=${body}`;
	}

	async function retryReconnect() {
		reconnectBusy = true;
		try {
			const opened = await connectionManager.reconnectRoom(bucketId);
			if (opened) {
				phase = 'chat';
				await loadRoomMeta();
			}
		} finally {
			reconnectBusy = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
		}
	}

	function onPinKey(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			void submitPin();
		}
	}

	function connStateLabel(): string {
		switch (connState) {
			case 'open':
				return 'Connected';
			case 'connecting':
				return 'Connecting';
			case 'reconnecting':
				return 'Reconnecting';
			case 'error':
				return 'Error';
			default:
				return 'Disconnected';
		}
	}
</script>

<svelte:window onresize={onWindowResize} />

<main class="chat">
	{#if bucketFull}
		<section class="blocked" role="alert">
			<a href="/app" class="back">{APP_NAME}</a>
			<div class="warn-mark" aria-hidden="true">!</div>
			<h1>Secure line full</h1>
			<p>
				This secure line already has two people connected. If you just unlocked the app or
				refreshed, try reconnecting — otherwise wait a moment and close extra tabs.
			</p>
			<p class="blocked-id">{LINE_ID_LABEL.toLowerCase()} <code>{bucketId}</code></p>
			<div class="blocked-actions">
				<button type="button" class="primary" disabled={reconnectBusy} onclick={() => retryReconnect()}>
					{reconnectBusy ? 'Reconnecting…' : 'Try reconnect'}
				</button>
				<a class="home-btn" href="/app">Back home</a>
			</div>
		</section>
	{:else if error && phase === 'loading'}
		<section class="pin-screen" role="alert">
			<a href="/app" class="back">{APP_NAME}</a>
			<h1>Cannot open chat</h1>
			<p class="pin-lede">{error}</p>
			<a class="primary home-link" href="/app">Back home</a>
		</section>
	{:else if phase === 'creator_share'}
		<section class="pin-screen" aria-labelledby="creator-pin-title">
			<a href="/app" class="back">{APP_NAME}</a>
			<h1 id="creator-pin-title">Your room PIN</h1>
			<p class="pin-lede">Share the <strong>link</strong> and this <strong>PIN</strong> separately.</p>
			<p class="pin-display" aria-label="Room PIN">{creatorPin}</p>
			<ShareQr value={shareUrl()} />
			<p class="pin-note">Anyone with both can join. The relay never sees your PIN or messages.</p>
			<div class="pin-actions">
				<div class="copy-row">
					<button type="button" class="copy-btn" disabled={shareBusy !== null} onclick={() => void shareCreatorQr()}>
						{shareFlash === 'qr' ? 'Shared' : shareBusy === 'qr' ? 'Sharing…' : 'Share QR'}
					</button>
					<button
						type="button"
						class="copy-btn primary"
						disabled={!creatorPin || shareBusy !== null}
						onclick={() => void shareCreatorInvite()}
					>
						{shareFlash === 'invite'
							? 'Shared'
							: shareBusy === 'invite'
								? 'Sharing…'
								: 'Share link + PIN'}
					</button>
				</div>
				<div class="copy-row">
					<button type="button" class="copy-btn" onclick={copyCreatorLink}>
						{copiedKind === 'link' ? 'Copied' : 'Copy link'}
					</button>
					<button type="button" class="copy-btn" onclick={copyCreatorPinOnly}>
						{copiedKind === 'pin' ? 'Copied' : 'Copy PIN'}
					</button>
					<button type="button" class="copy-btn" onclick={copyCreatorShare}>
						{copiedKind === 'both' ? 'Copied' : 'Copy link + PIN'}
					</button>
				</div>
				<button type="button" class="secondary" onclick={continueFromCreatorModal}>Enter chat</button>
			</div>
		</section>
	{:else if phase === 'line_pin'}
		<section class="pin-screen" aria-labelledby="pin-title">
			<a href="/app" class="back">{APP_NAME}</a>
			<h1 id="pin-title">Enter room PIN</h1>
			<p class="pin-lede">Ask your partner for the 6-digit PIN that goes with this link.</p>
			<form
				class="pin-form"
				onsubmit={(e) => {
					e.preventDefault();
					void submitPin();
				}}
			>
				<input
					type="text"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength="6"
					autocomplete="one-time-code"
					placeholder="000000"
					bind:value={pinInput}
					onkeydown={onPinKey}
					aria-invalid={pinError ? 'true' : undefined}
				/>
				{#if pinError}
					<p class="pin-err" role="alert">{pinError}</p>
				{/if}
				<button type="submit" class="primary">Join room</button>
			</form>
			<p class="pin-note">Wrong PIN? You will not connect.</p>
		</section>
	{:else}
		<div class="chat-shell">
			<aside class="chat-sidebar" aria-label="Your chats">
				<ChatListSidePanel />
			</aside>
			<div class="chat-main">
				<header>
					<div class="header-top">
						<a href="/app" class="back">{APP_NAME}</a>
						<div class="actions">
							{#if isCreator && !legacyMode}
								<button
									type="button"
									class="icon-btn"
									aria-label="Share invite"
									title="Share"
									onclick={() => void openShare()}
								>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
										<circle cx="18" cy="5" r="2.25" stroke="currentColor" stroke-width="1.75" />
										<circle cx="6" cy="12" r="2.25" stroke="currentColor" stroke-width="1.75" />
										<circle cx="18" cy="19" r="2.25" stroke="currentColor" stroke-width="1.75" />
										<path
											d="M8.1 10.9l7.8-4.3M8.1 13.1l7.8 4.3"
											stroke="currentColor"
											stroke-width="1.75"
											stroke-linecap="round"
										/>
									</svg>
								</button>
							{/if}
							<button
								type="button"
								class="icon-btn"
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
							<button
								type="button"
								class="icon-btn"
								aria-expanded={infoOpen}
								aria-label="Chat details"
								title="Chat details"
								onclick={() => (infoOpen = !infoOpen)}
							>
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
									<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.75" />
									<path
										d="M12 10v6M12 7h.01"
										stroke="currentColor"
										stroke-width="1.75"
										stroke-linecap="round"
									/>
								</svg>
							</button>
							<button
								type="button"
								class="icon-btn"
								aria-label="Export chat"
								title="Export"
								onclick={doExport}
							>
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
									<path
										d="M12 3v12m0 0l-4-4m4 4l4-4M5 19h14"
										stroke="currentColor"
										stroke-width="1.75"
										stroke-linecap="round"
										stroke-linejoin="round"
									/>
								</svg>
							</button>
							{#if notifyPerm === 'default'}
								<button
									type="button"
									class="icon-btn"
									aria-label="Enable alerts"
									title="Enable alerts"
									onclick={enableNotifications}
								>
									<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
										<path
											d="M6 17h12l-1.2-1.2A2 2 0 0116 14.3V11a4 4 0 10-8 0v3.3c0 .5-.2 1-.6 1.4L6 17z"
											stroke="currentColor"
											stroke-width="1.75"
											stroke-linejoin="round"
										/>
										<path d="M10 17a2 2 0 004 0" stroke="currentColor" stroke-width="1.75" />
									</svg>
								</button>
							{:else if notifyPerm === 'granted'}
								<span class="stat icon-stat" title="Alerts on" aria-label="Alerts on">
									<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
										<path
											d="M6 17h12l-1.2-1.2A2 2 0 0116 14.3V11a4 4 0 10-8 0v3.3c0 .5-.2 1-.6 1.4L6 17z"
											stroke="currentColor"
											stroke-width="1.75"
											stroke-linejoin="round"
										/>
										<path d="M10 17a2 2 0 004 0" stroke="currentColor" stroke-width="1.75" />
									</svg>
								</span>
							{/if}
						</div>
					</div>
					<div
						class="presence"
						class:live={connState === 'open' && partnerConnected}
						class:waiting={presenceWaiting}
						title={presenceHint}
					>
						<span class="presence-title">
							{presenceLabel}{#if presenceWaiting}<span class="wait-dots" aria-hidden="true"
									><span></span><span></span><span></span></span
								>{/if}
						</span>
					</div>
				</header>

				{#if showConnBanner}
					<div
						class="conn-banner"
						class:offline
						class:warn={connState === 'reconnecting' ||
							connState === 'closed' ||
							connState === 'error'}
						class:lost={reconnectStalled}
						role="status"
					>
						<span class="conn-banner-dot" aria-hidden="true"></span>
						<div class="conn-banner-text">
							{#if offline}
								<strong>You appear offline</strong>
								<span>Messages will send again when your network returns.</span>
							{:else if reconnectStalled}
								<strong>Connection lost</strong>
								<span>Could not restore the secure line automatically.</span>
							{:else if connState === 'reconnecting'}
								<strong>
									{reconnectAttempt > 1
										? `Reconnecting… (attempt ${reconnectAttempt})`
										: 'Reconnecting…'}
								</strong>
								<span>Restoring your secure connection.</span>
							{:else}
								<strong>Connection interrupted</strong>
								<span>Trying to restore your secure connection.</span>
							{/if}
						</div>
						{#if reconnectStalled}
							<button
								type="button"
								class="conn-reconnect-btn"
								disabled={reconnectBusy}
								onclick={() => retryReconnect()}
							>
								{reconnectBusy ? 'Reconnecting…' : 'Reconnect now'}
							</button>
						{/if}
					</div>
				{/if}

				{#if legacyMode}
					<p class="legacy-banner" role="status">
						Legacy link (no room PIN). Reconnect may show “secure line full” — create a new chat for
						reliable rejoin.
					</p>
				{/if}

				{#if infoOpen}
					<section class="info-panel" aria-label="Chat details">
						<dl>
							<div>
								<dt>Partner name</dt>
								<dd>
									<input
										type="text"
										class="nick-input"
										bind:value={editNickname}
										maxlength="64"
										placeholder="Local label — only you see this"
										onchange={() => savePartnerName()}
									/>
								</dd>
							</div>
							<div>
								<dt>{LINE_ID_LABEL}</dt>
								<dd><code>{bucketId}</code></dd>
							</div>
							<div>
								<dt>Relay</dt>
								<dd><code>{relayUrl || '—'}</code></dd>
							</div>
							<div>
								<dt>Connection</dt>
								<dd>{connStateLabel()}{connDetail ? ` (${connDetail})` : ''}</dd>
							</div>
						</dl>
						<DeviceSettings compact />
					</section>
				{/if}

				{#if error}
					<p class="err">{error}</p>
				{/if}

				<div class="list-wrap">
					<div class="list" bind:this={listEl} onscroll={updateScrollPin}>
						{#each messages as m (m.id)}
							<article class:self={m.from === 'self'}>
								<span class="who">{m.from === 'self' ? 'You' : partnerLabelText}</span>
								<p>{m.body}</p>
								<time>{new Date(m.ts).toLocaleTimeString()}</time>
							</article>
						{/each}
					</div>

					{#if showScrollDown}
						<button type="button" class="scroll-down" onclick={() => scrollToBottom(true)}>
							New messages ↓
						</button>
					{/if}
				</div>

				<div class="dock">
					<button type="button" class="chats-btn" onclick={openChatsSheet}>
						<span class="chats-label">Tap to see chats</span>
						{#if hasOtherUnread}
							<span class="chats-unread" aria-label="Unread"></span>
						{/if}
					</button>

					<div class="dock-body">
						<form
							class="composer"
							onsubmit={(e) => {
								e.preventDefault();
								void send();
							}}
						>
							<textarea
								bind:value={draft}
								rows="2"
								placeholder="Message…"
								onkeydown={onKey}
								disabled={!key || !!error || connState !== 'open'}
							></textarea>
							<button type="submit" disabled={!draft.trim() || !key || !!error || connState !== 'open'}
								>Send</button
							>
						</form>

						<details class="tools">
							<summary>Export options & report</summary>
							<label>
								<input type="checkbox" bind:checked={passOnly} />
								Passphrase-only export (import without session key)
							</label>
							<input type="password" bind:value={exportPass} placeholder="Optional passphrase" />
							<button type="button" onclick={doExport}>Download export</button>
							<hr />
							<input type="text" bind:value={reportNote} placeholder="Report note (no content)" />
							<button type="button" class="danger" onclick={reportLine}
								>Report this {SECURE_LINE}</button
							>
						</details>
					</div>
				</div>
			</div>
		</div>
	{/if}

	{#if showNicknamePrompt}
		<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
		<div class="nick-overlay" role="dialog" aria-labelledby="nick-prompt-title">
			<div class="nick-dialog">
				<h2 id="nick-prompt-title">Name your partner</h2>
				<p class="nick-hint">Only you see this — it stays on this device.</p>
				<label class="nick-field">
					<span>Partner name</span>
					<input
						type="text"
						bind:value={editNickname}
						maxlength="64"
						placeholder="How you remember them"
					/>
				</label>
				<div class="nick-actions">
					<button type="button" onclick={() => (showNicknamePrompt = false)}>Skip</button>
					<button type="button" class="primary" onclick={() => savePartnerName()}>Save</button>
				</div>
			</div>
		</div>
	{/if}

	{#if chatsOpen}
		<ChatListSheet open={chatsOpen} onClose={() => (chatsOpen = false)} />
	{/if}
	<AppSettings open={settingsOpen} onClose={() => (settingsOpen = false)} />
	{#if shareRoom}
		<ShareInviteModal room={shareRoom} onClose={() => (shareRoom = null)} />
	{/if}
</main>

<style>
	.chat {
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
	}

	@media (min-width: 720px) {
		.chat {
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

	.pin-screen {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0.5rem 0 2rem;
		max-width: 24rem;
		margin: 0 auto;
		width: 100%;
		overflow-y: auto;
	}

	.pin-screen h1 {
		font-family: var(--font-display);
		font-size: 1.75rem;
		margin: 0.5rem 0 0;
	}

	.pin-lede {
		margin: 0;
		color: var(--muted);
		line-height: 1.5;
	}

	.pin-display {
		font-family: ui-monospace, monospace;
		font-size: 2.5rem;
		font-weight: 700;
		letter-spacing: 0.35em;
		text-align: center;
		margin: 1rem 0;
		color: var(--accent);
	}

	.pin-form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.pin-form input {
		font: inherit;
		font-family: ui-monospace, monospace;
		font-size: 1.5rem;
		letter-spacing: 0.25em;
		text-align: center;
		padding: 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
	}

	.pin-err {
		margin: 0;
		color: var(--danger);
		font-size: 0.9rem;
	}

	.pin-note {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
		line-height: 1.45;
	}

	.pin-actions {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		margin-top: 0.5rem;
	}

	.copy-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}

	.copy-btn {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.65rem 1rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
		flex: 1 1 auto;
		min-width: 7rem;
	}

	.copy-btn.primary {
		border: none;
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
	}

	.copy-btn:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.primary {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.75rem 1.2rem;
		border: none;
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
	}

	.secondary {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.75rem 1.2rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
	}

	.home-link {
		display: inline-block;
		text-align: center;
		text-decoration: none;
		margin-top: 0.5rem;
	}

	.legacy-banner {
		flex-shrink: 0;
		margin: 0;
		padding: 0.55rem 0.75rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.65);
		color: var(--muted);
		font-size: 0.85rem;
		line-height: 1.4;
	}

	.blocked {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		text-align: center;
		padding: 2rem 1rem 3rem;
		gap: 0.85rem;
	}

	.blocked .back {
		align-self: flex-start;
		margin-bottom: auto;
	}

	.warn-mark {
		width: 4.5rem;
		height: 4.5rem;
		border-radius: 50%;
		border: 3px solid var(--danger);
		color: var(--danger);
		font-family: var(--font-display);
		font-weight: 800;
		font-size: 2.4rem;
		line-height: 4.3rem;
		margin-top: auto;
	}

	.blocked h1 {
		font-family: var(--font-display);
		font-size: clamp(1.75rem, 5vw, 2.25rem);
		margin: 0;
		color: var(--ink);
	}

	.blocked p {
		margin: 0;
		max-width: 28ch;
		color: var(--muted);
		line-height: 1.55;
	}

	.blocked-id {
		font-size: 0.9rem;
	}

	.blocked-id code {
		font-family: ui-monospace, monospace;
		color: var(--ink);
	}

	.blocked-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.65rem;
		align-items: center;
		margin-top: 0.5rem;
	}

	.blocked-actions .primary {
		font: inherit;
		cursor: pointer;
		border: none;
		border-radius: 0.35rem;
		padding: 0.75rem 1.25rem;
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
	}

	.home-btn {
		margin-top: 0.5rem;
		margin-bottom: auto;
		display: inline-block;
		padding: 0.75rem 1.25rem;
		border-radius: 0.35rem;
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
		text-decoration: none;
	}

	header {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 0.35rem;
	}

	.header-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.55rem;
		min-height: 2.25rem;
	}

	.back {
		font-family: var(--font-display);
		font-weight: 800;
		font-size: 1.05rem;
		text-decoration: none;
		color: var(--ink);
		flex-shrink: 0;
		line-height: 1;
	}

	.presence {
		min-width: 0;
		display: flex;
		align-items: baseline;
	}

	.presence-title {
		font-size: 0.88rem;
		font-weight: 600;
		color: var(--muted);
		line-height: 1.25;
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
	}

	.presence.live .presence-title {
		color: var(--accent);
	}

	.wait-dots {
		display: inline-flex;
		align-items: center;
		gap: 0.2rem;
		height: 0.85em;
	}

	.wait-dots span {
		width: 0.28rem;
		height: 0.28rem;
		border-radius: 50%;
		background: currentColor;
		opacity: 0.35;
		animation: wait-dot 1.2s ease-in-out infinite;
	}

	.wait-dots span:nth-child(2) {
		animation-delay: 0.2s;
	}

	.wait-dots span:nth-child(3) {
		animation-delay: 0.4s;
	}

	@keyframes wait-dot {
		0%,
		80%,
		100% {
			opacity: 0.3;
			transform: translateY(0);
		}
		40% {
			opacity: 1;
			transform: translateY(-0.12rem);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.wait-dots span {
			animation: none;
			opacity: 0.7;
		}
	}

	.conn-banner {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		gap: 0.65rem;
		padding: 0.55rem 0.75rem;
		border-radius: 0.35rem;
		border: 1px solid rgba(61, 220, 176, 0.25);
		background: rgba(61, 220, 176, 0.08);
		color: var(--ink);
	}

	.conn-banner.warn {
		border-color: rgba(255, 193, 77, 0.35);
		background: rgba(255, 193, 77, 0.08);
	}

	.conn-banner.offline {
		border-color: rgba(160, 170, 165, 0.35);
		background: rgba(160, 170, 165, 0.1);
	}

	.conn-banner.lost {
		border-color: rgba(255, 107, 107, 0.35);
		background: rgba(255, 107, 107, 0.08);
	}

	.conn-banner-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--accent);
		animation: conn-pulse 1.4s ease-in-out infinite;
	}

	.conn-banner.warn .conn-banner-dot {
		background: #ffc14d;
	}

	.conn-banner.offline .conn-banner-dot {
		background: var(--muted);
		animation: none;
	}

	.conn-banner.lost .conn-banner-dot {
		background: var(--danger);
		animation: none;
	}

	.conn-banner-text {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.1rem;
		font-size: 0.82rem;
		line-height: 1.35;
	}

	.conn-banner-text strong {
		font-size: 0.88rem;
		font-weight: 600;
	}

	.conn-banner-text span {
		color: var(--muted);
	}

	.conn-reconnect-btn {
		flex-shrink: 0;
		font: inherit;
		font-size: 0.82rem;
		font-weight: 600;
		padding: 0.4rem 0.7rem;
		border-radius: 0.3rem;
		border: none;
		background: var(--accent);
		color: #06110d;
		cursor: pointer;
	}

	.conn-reconnect-btn:disabled {
		opacity: 0.65;
		cursor: default;
	}

	@keyframes conn-pulse {
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

	.actions {
		display: flex;
		gap: 0.3rem;
		align-items: center;
		flex-wrap: nowrap;
		flex-shrink: 0;
	}

	.stat {
		font-size: 0.8rem;
		color: var(--muted);
	}

	.stat.icon-stat {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		color: var(--accent);
	}

	button {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.45rem 0.75rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
	}

	.icon-btn {
		padding: 0.35rem;
		line-height: 0;
		color: var(--muted);
		width: 2rem;
		height: 2rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.icon-btn[aria-expanded='true'] {
		border-color: var(--accent-dim);
		color: var(--accent);
	}

	.info-panel {
		flex-shrink: 0;
		padding: 0.75rem 0.85rem;
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		background: rgba(18, 26, 23, 0.65);
		font-size: 0.85rem;
	}

	.info-panel dl {
		margin: 0;
		display: grid;
		gap: 0.55rem;
	}

	.info-panel dt {
		font-size: 0.7rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--muted);
		margin-bottom: 0.15rem;
	}

	.info-panel dd {
		margin: 0;
		color: var(--ink);
		word-break: break-all;
	}

	.info-panel code {
		font-family: ui-monospace, monospace;
		font-size: 0.82rem;
	}

	.nick-input {
		font: inherit;
		width: 100%;
		padding: 0.4rem 0.55rem;
		border-radius: 0.3rem;
		border: 1px solid var(--line);
		background: rgba(10, 12, 14, 0.6);
		color: var(--ink);
	}

	.nick-overlay {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.55);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}

	.nick-dialog {
		background: var(--bg1);
		border: 1px solid var(--line);
		border-radius: 0.5rem;
		padding: 1.25rem;
		width: min(100%, 22rem);
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}

	.nick-dialog h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.25rem;
	}

	.nick-hint {
		margin: 0;
		color: var(--muted);
		font-size: 0.9rem;
		line-height: 1.45;
	}

	.nick-field {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
	}

	.nick-field span {
		color: var(--muted);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.nick-dialog input {
		font: inherit;
		padding: 0.65rem 0.75rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
	}

	.nick-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
	}

	.nick-actions button {
		font: inherit;
		padding: 0.5rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
		cursor: pointer;
	}

	.nick-actions .primary {
		background: var(--accent);
		color: #06110d;
		border: none;
		font-weight: 600;
	}

	.err {
		flex-shrink: 0;
		color: var(--danger);
		margin: 0;
	}

	.list-wrap {
		position: relative;
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.list {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
		padding: 0.25rem 0 0.5rem;
		-webkit-overflow-scrolling: touch;
	}

	.scroll-down {
		position: absolute;
		left: 50%;
		bottom: 0.5rem;
		transform: translateX(-50%);
		z-index: 2;
		padding: 0.4rem 0.85rem;
		border-radius: 999px;
		background: rgba(10, 12, 14, 0.92);
		border: 1px solid var(--accent-dim);
		color: var(--accent);
		font-size: 0.82rem;
		font-weight: 600;
		box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
	}

	.dock {
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 0;
		background: transparent;
		border: none;
		overflow: visible;
	}

	.dock-body {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.5rem 0.75rem calc(0.85rem + env(safe-area-inset-bottom, 0px));
		background: var(--bg0);
		border-left: 1px solid var(--line);
		border-right: 1px solid var(--line);
		border-top: 1px solid var(--line);
	}

	.chats-btn {
		font: inherit;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.45rem;
		width: 100%;
		margin: 0;
		padding: 0.35rem 1rem 0;
		border: none;
		background: var(--accent);
		color: black;
		/* Upside moon: full height at center, ~0 at both edges */
		height: 2rem;
		border-radius: 0;
		clip-path: ellipse(50% 100% at 50% 100%);
		font-size: 0.82rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		line-height: 1;
		flex-shrink: 0;
		position: relative;
		z-index: 1;
	}

	.chats-btn:hover {
		filter: brightness(1.05);
	}

	@media (min-width: 720px) {
		.chats-btn {
			display: none !important;
		}

		.dock-body {
			border-top: 1px solid var(--line);
			border-radius: 0.5rem 0.5rem 0 0;
		}
	}

	.chats-label {
		text-align: center;
		padding-bottom: 0.15rem;
	}

	.chats-unread {
		width: 0.45rem;
		height: 0.45rem;
		border-radius: 50%;
		background: black;
		flex-shrink: 0;
	}

	.dock .composer,
	.dock .tools {
		margin-left: 0;
		margin-right: 0;
		padding-left: 0;
		padding-right: 0;
	}

	.dock .composer {
		padding-top: 0;
	}

	article {
		max-width: 85%;
		align-self: flex-start;
		padding: 0.65rem 0.85rem;
		border-radius: 0.5rem 0.5rem 0.5rem 0.15rem;
		background: rgba(18, 26, 23, 0.9);
		border: 1px solid var(--line);
		animation: in 0.25s ease both;
	}

	article.self {
		align-self: flex-end;
		border-radius: 0.5rem 0.5rem 0.15rem 0.5rem;
		background: rgba(61, 220, 176, 0.12);
		border-color: rgba(61, 220, 176, 0.35);
	}

	article p {
		margin: 0;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.who {
		display: block;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
		margin-bottom: 0.3rem;
	}

	article.self .who {
		color: var(--accent);
		text-align: right;
	}

	time {
		display: block;
		margin-top: 0.35rem;
		font-size: 0.7rem;
		color: var(--muted);
	}

	@keyframes in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.composer {
		display: grid;
		grid-template-columns: 1fr auto;
		gap: 0.5rem;
		align-items: end;
	}

	textarea {
		font: inherit;
		resize: vertical;
		min-height: 3rem;
		padding: 0.7rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
	}

	.composer button[type='submit'] {
		background: var(--accent);
		color: #06110d;
		border: none;
		font-weight: 600;
		padding: 0.75rem 1rem;
	}

	.tools {
		color: var(--muted);
		font-size: 0.9rem;
	}

	.tools summary {
		cursor: pointer;
	}

	.tools input[type='password'],
	.tools input[type='text'] {
		display: block;
		width: 100%;
		margin: 0.5rem 0;
		font: inherit;
		padding: 0.5rem 0.65rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
	}

	.danger {
		border-color: var(--danger);
		color: var(--danger);
	}

	hr {
		border: none;
		border-top: 1px solid var(--line);
		margin: 0.75rem 0;
	}

	@media (prefers-reduced-motion: reduce) {
		article {
			animation: none;
		}
	}
</style>
