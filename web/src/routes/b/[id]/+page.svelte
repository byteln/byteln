<script lang="ts">
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import {
		exportHistory,
		exportHistoryWithPassphraseOnly,
		type StoredMessage
	} from '$lib/crypto/backup';
	import {
		decryptMessage,
		encryptMessage,
		importKeyRaw,
		keyFromFragment,
		keyToFragment,
		randomToken
	} from '$lib/crypto/session';
	import { RelayClient } from '$lib/relay/client';
	import {
		ensureNotifyPermission,
		getNotifyPermission,
		notifyPartnerJoined,
		notifyPartnerMessage,
		type NotifyPermission
	} from '$lib/notify';
	import { defaultRelayUrl } from '$lib/servers/directory';
	import {
		addMessage,
		getSessionToken,
		listMessages,
		resolveRelayUrl,
		setSessionToken
	} from '$lib/storage/history';
	import { onDestroy, onMount } from 'svelte';

	const bucketId = $derived(page.params.id ?? '');
	const SCROLL_THRESHOLD = 72;

	let key = $state<CryptoKey | null>(null);
	let messages = $state<StoredMessage[]>([]);
	let draft = $state('');
	let connState = $state<'connecting' | 'open' | 'closed' | 'error' | 'reconnecting'>('connecting');
	let connDetail = $state('');
	let peerPresent = $state(false);
	let slot = $state<number | null>(null);
	let error = $state('');
	let relayUrl = $state('');
	let shareOpen = $state(false);
	let exportPass = $state('');
	let passOnly = $state(false);
	let reportNote = $state('');
	let notifyPerm = $state<NotifyPermission>('unsupported');
	let bucketFull = $state(false);
	let infoOpen = $state(false);
	let pinnedToBottom = $state(true);

	let client: RelayClient | null = null;
	let listEl = $state<HTMLElement | null>(null);

	const showScrollDown = $derived(!pinnedToBottom && messages.length > 0);

	const presenceLabel = $derived.by(() => {
		if (connState === 'connecting' || connState === 'reconnecting') {
			return connState === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
		}
		if (connState === 'closed' || connState === 'error') {
			return 'Disconnected — retrying';
		}
		return peerPresent ? 'Partner connected' : 'Waiting for partner';
	});

	const presenceHint = $derived.by(() => {
		if (connState === 'open' && peerPresent) return 'Your partner is in this chat.';
		if (connState === 'open') return 'Share the link so they can join.';
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

	function wireClient(c: RelayClient) {
		c.onStatus = (s, detail) => {
			connState = s;
			connDetail = detail ?? '';
			if (s === 'closed' && detail === 'bucket full') {
				bucketFull = true;
				c.close();
				client = null;
			}
			if (s === 'closed' || s === 'error') {
				peerPresent = false;
			}
		};
		c.onControl = (msg) => {
			if (msg.t === 'slot' && typeof msg.n === 'number') slot = msg.n;
			if (msg.t === 'peer_join') {
				peerPresent = true;
				notifyPartnerJoined(bucketId);
			}
			if (msg.t === 'peer_leave') peerPresent = false;
		};
		c.onBinary = async (buf) => {
			if (!key || bucketFull) return;
			try {
				const plain = await decryptMessage(key, buf);
				const stored: StoredMessage = {
					...plain,
					id: crypto.randomUUID(),
					from: 'peer'
				};
				messages = [...messages, stored];
				await addMessage(bucketId, stored);
				notifyPartnerMessage({ body: plain.body, bucketId });
				queueMicrotask(() => scrollToBottom());
			} catch (e) {
				console.warn('byteln: decrypt failed', e);
				error =
					'Received bytes but could not decrypt — both sides need the same #key= in the URL.';
			}
		};
	}

	onMount(async () => {
		notifyPerm = getNotifyPermission();
		if (!bucketId) return;
		try {
			let raw = keyFromFragment(location.hash);
			if (!raw) {
				error = 'Missing #key= in the URL. Ask the creator for the full share link.';
				return;
			}
			key = await importKeyRaw(raw);
			history.replaceState(null, '', `${location.pathname}#key=${keyToFragment(raw)}`);

			messages = await listMessages(bucketId);
			queueMicrotask(() => scrollToBottom(true));

			let token = await getSessionToken(bucketId);
			if (!token) {
				token = randomToken();
				await setSessionToken(bucketId, token);
			}

			const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
			const relay = await resolveRelayUrl(fallback);
			relayUrl = relay;
			client = new RelayClient(relay, bucketId, token);
			wireClient(client);
			client.connect();
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to start';
		}
	});

	async function enableNotifications() {
		notifyPerm = await ensureNotifyPermission();
	}
	onDestroy(() => client?.close());

	async function send() {
		const body = draft.trim();
		if (!body || !key || !client) return;
		const plain = { v: 1 as const, ts: Date.now(), type: 'text' as const, body };
		const buf = await encryptMessage(key, plain);
		client.sendBinary(buf);
		const stored: StoredMessage = { ...plain, id: crypto.randomUUID(), from: 'self' };
		messages = [...messages, stored];
		draft = '';
		await addMessage(bucketId, stored);
		queueMicrotask(() => scrollToBottom(true));
	}

	function shareUrl(): string {
		return `${location.origin}/b/${bucketId}${location.hash}`;
	}

	async function copyShare() {
		await navigator.clipboard.writeText(shareUrl());
		shareOpen = true;
		setTimeout(() => (shareOpen = false), 1500);
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

	function reportBucket() {
		const subject = encodeURIComponent(`byteln report: ${bucketId}`);
		const body = encodeURIComponent(
			`Bucket ID: ${bucketId}\nNote: ${reportNote || '(none)'}\n\nNo message content included.`
		);
		location.href = `mailto:?subject=${subject}&body=${body}`;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void send();
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
			<a href="/" class="back">byteln</a>
			<div class="warn-mark" aria-hidden="true">!</div>
			<h1>Bucket full</h1>
			<p>
				This chat already has two peers connected. A bucket only holds two devices — ask them to
				share a new link, or wait until a slot frees up.
			</p>
			<p class="blocked-id">bucket <code>{bucketId}</code></p>
			<a class="home-btn" href="/">Back home</a>
		</section>
	{:else}
		<header>
			<a href="/" class="back">byteln</a>
			<div class="presence" class:live={connState === 'open' && peerPresent}>
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
				<button type="button" onclick={copyShare}>{shareOpen ? 'Copied' : 'Share link'}</button>
				<button type="button" onclick={doExport}>Export</button>
				{#if notifyPerm === 'default'}
					<button type="button" onclick={enableNotifications}>Enable alerts</button>
				{:else if notifyPerm === 'granted'}
					<span class="stat">alerts on</span>
				{/if}
			</div>
		</header>

		{#if infoOpen}
			<section class="info-panel" aria-label="Chat details">
				<dl>
					<div>
						<dt>Bucket</dt>
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
					{#if slot !== null}
						<div>
							<dt>Your slot</dt>
							<dd>{slot === 0 ? 'A' : 'B'}</dd>
						</div>
					{/if}
				</dl>
			</section>
		{/if}

		{#if error}
			<p class="err">{error}</p>
		{/if}

		<div class="list-wrap">
			<div class="list" bind:this={listEl} onscroll={updateScrollPin}>
				{#each messages as m (m.id)}
					<article class:self={m.from === 'self'}>
						<span class="who">{m.from === 'self' ? 'You' : 'Partner'}</span>
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
				<button type="button" class="danger" onclick={reportBucket}>Report this bucket</button>
			</details>
		</div>
	{/if}
</main>

<style>
	.chat {
		position: relative;
		z-index: 1;
		max-width: 40rem;
		margin: 0 auto;
		height: 100dvh;
		display: flex;
		flex-direction: column;
		padding: 1rem 1rem 0;
		gap: 0.75rem;
		overflow: hidden;
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
