<script lang="ts">
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import ConversationTabs from '$lib/components/ConversationTabs.svelte';
	import DeviceSettings from '$lib/components/DeviceSettings.svelte';
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
		resolveRelayUrl,
		setNickname,
		setSessionToken
	} from '$lib/storage/history';
	import { APP_NAME, LINE_ID_LABEL, partnerDisplayName, SECURE_LINE } from '$lib/brand';
	import { bumpRooms, roomsRevision } from '$lib/stores/conversations';
	import { onMount } from 'svelte';

	const bucketId = $derived(page.params.id ?? '');
	const SCROLL_THRESHOLD = 72;

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

	let listEl = $state<HTMLElement | null>(null);

	const messages = $derived(($messagesByBucket[bucketId] ?? []) as StoredMessage[]);
	const runtime = $derived($roomRuntimes[bucketId]);
	const connState = $derived(runtime?.connState ?? 'connecting');
	const connDetail = $derived(runtime?.connDetail ?? '');
	const peerPresent = $derived(runtime?.peerPresent ?? false);
	const partnerConnected = $derived(
		peerPresent || messages.some((m) => m.from === 'peer')
	);
	const bucketFull = $derived(runtime?.bucketFull ?? false);
	const partnerLabelText = $derived(partnerDisplayName(nickname, bucketId));

	const showScrollDown = $derived(!pinnedToBottom && messages.length > 0);

	const presenceLabel = $derived.by(() => {
		if (phase !== 'chat') return 'Enter room PIN';
		if (connState === 'connecting' || connState === 'reconnecting') {
			return connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
		}
		if (connState === 'closed' || connState === 'error') {
			return 'Disconnected — retrying';
		}
		return partnerConnected ? `${partnerLabelText} connected` : `Waiting for ${partnerLabelText}`;
	});

	const presenceHint = $derived.by(() => {
		if (phase === 'creator_share') return 'Share the link and PIN with your partner separately.';
		if (phase === 'line_pin') return 'The PIN is not in the link — ask whoever invited you.';
		if (connState === 'open' && partnerConnected) return `${partnerLabelText} is in this chat.`;
		if (connState === 'open' && isCreator) return 'Share the link and room PIN with your partner.';
		if (connState === 'open') return `Connected — waiting for ${partnerLabelText} to join.`;
		if (connState === 'reconnecting' || connState === 'closed' || connState === 'error') {
			return 'Trying to restore your connection automatically.';
		}
		return 'Opening a secure channel to the relay.';
	});

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

	onMount(() => {
		notifyPerm = getNotifyPermission();
		const unsubNames = roomsRevision.subscribe(() => {
			void loadNames();
		});

		void (async () => {
			if (!bucketId) return;
			try {
				await connectionManager.setActive(bucketId);
				await loadNames();

				let hash = location.hash;
				if (!hash.includes('key=')) {
					const rec = await getRoom(bucketId);
					const creds = await connectionManager.getRoomCredentials(bucketId);
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
				history.replaceState(null, '', `${location.pathname}${hash}`);

				const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
				relayUrl = await resolveRelayUrl(fallback);

				if (!connectionManager.isOpen(bucketId)) {
					const msgs = await listMessages(bucketId);
					messagesByBucket.update((m) => ({ ...m, [bucketId]: msgs }));
				}

				if (parsed.legacy) {
					legacyMode = true;
					await connectLegacy();
					await ensureRoomRegistered(parsed);
					return;
				}

				const once = takeCreatorPin(bucketId);
				if (once) {
					creatorPin = once;
					isCreator = true;
					phase = 'creator_share';
					await ensureRoomRegistered(parsed);
					return;
				}

				const rt = connectionManager.getRuntime(bucketId);
				if (rt?.bucketFull) {
					phase = 'chat';
					await loadRoomMeta();
					return;
				}

				const opened = await connectionManager.openRoom(bucketId);
				if (opened) {
					await ensureRoomRegistered(parsed);
					await loadRoomMeta();
					await enterChatPhase(false);
					return;
				}

				if (connectionManager.getRuntime(bucketId)?.bucketFull) {
					phase = 'chat';
					return;
				}

				await ensureRoomRegistered(parsed);
				if (pinHint && /^\d{6}$/.test(pinHint)) {
					await connectWithPin(pinHint);
					return;
				}
				phase = 'line_pin';
			} catch (e) {
				error = e instanceof Error ? e.message : 'failed to start';
			}
		})();

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
		const text = `Open this link in your browser:\n${shareUrl()}\n\nRoom PIN (enter separately — do not paste into the URL):\n${creatorPin}`;
		await navigator.clipboard.writeText(text);
		flashCopied('both');
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

<main class="chat">
	{#if bucketFull}
		<section class="blocked" role="alert">
			<a href="/" class="back">{APP_NAME}</a>
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
				<a class="home-btn" href="/">Back home</a>
			</div>
		</section>
	{:else if error && phase === 'loading'}
		<section class="pin-screen" role="alert">
			<a href="/" class="back">{APP_NAME}</a>
			<h1>Cannot open chat</h1>
			<p class="pin-lede">{error}</p>
			<a class="primary home-link" href="/">Back home</a>
		</section>
	{:else if phase === 'creator_share'}
		<section class="pin-screen" aria-labelledby="creator-pin-title">
			<a href="/" class="back">{APP_NAME}</a>
			<h1 id="creator-pin-title">Your room PIN</h1>
			<p class="pin-lede">Share the <strong>link</strong> and this <strong>PIN</strong> separately.</p>
			<p class="pin-display" aria-label="Room PIN">{creatorPin}</p>
			<p class="pin-note">Anyone with both can join. The relay never sees your PIN or messages.</p>
			<div class="pin-actions">
				<div class="copy-row">
					<button type="button" class="copy-btn" onclick={copyCreatorLink}>
						{copiedKind === 'link' ? 'Copied' : 'Copy link'}
					</button>
					<button type="button" class="copy-btn" onclick={copyCreatorPinOnly}>
						{copiedKind === 'pin' ? 'Copied' : 'Copy PIN'}
					</button>
					<button type="button" class="copy-btn primary" onclick={copyCreatorShare}>
						{copiedKind === 'both' ? 'Copied' : 'Copy link + PIN'}
					</button>
				</div>
				<button type="button" class="secondary" onclick={continueFromCreatorModal}>Enter chat</button>
			</div>
		</section>
	{:else if phase === 'line_pin'}
		<section class="pin-screen" aria-labelledby="pin-title">
			<a href="/" class="back">{APP_NAME}</a>
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
		<header>
			<a href="/" class="back">{APP_NAME}</a>
			<div class="presence" class:live={connState === 'open' && partnerConnected}>
				<span class="presence-title">{presenceLabel}</span>
				<span class="presence-hint">{presenceHint}</span>
			</div>
			<div class="actions">
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
						<path d="M12 10v6M12 7h.01" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" />
					</svg>
				</button>
				<button type="button" onclick={doExport}>Export</button>
				{#if notifyPerm === 'default'}
					<button type="button" onclick={enableNotifications}>Enable alerts</button>
				{:else if notifyPerm === 'granted'}
					<span class="stat">alerts on</span>
				{/if}
			</div>
		</header>

		<ConversationTabs variant="compact" />

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
				<button type="button" class="danger" onclick={reportLine}>Report this {SECURE_LINE}</button>
			</details>
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

	.pin-screen {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		padding: 0.5rem 0 2rem;
		max-width: 22rem;
		margin: 0 auto;
		width: 100%;
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
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 0.75rem;
		justify-content: space-between;
	}

	.back {
		font-family: var(--font-display);
		font-weight: 800;
		font-size: 1.35rem;
		text-decoration: none;
		color: var(--ink);
	}

	.presence {
		flex: 1;
		min-width: 10rem;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.presence-title {
		font-size: 0.95rem;
		font-weight: 600;
		color: var(--muted);
	}

	.presence.live .presence-title {
		color: var(--accent);
	}

	.presence-hint {
		font-size: 0.8rem;
		color: var(--muted);
		line-height: 1.35;
	}

	.actions {
		display: flex;
		gap: 0.4rem;
		align-items: center;
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.stat {
		font-size: 0.8rem;
		color: var(--muted);
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
		padding: 0.4rem;
		line-height: 0;
		color: var(--muted);
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
		padding: 0.65rem 0 calc(0.85rem + env(safe-area-inset-bottom, 0px));
		background: var(--bg0);
		border-top: 1px solid var(--line);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
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
