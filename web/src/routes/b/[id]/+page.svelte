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

	let key = $state<CryptoKey | null>(null);
	let messages = $state<StoredMessage[]>([]);
	let draft = $state('');
	let status = $state('idle');
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

	let client: RelayClient | null = null;
	let listEl: HTMLElement | null = null;

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
			let token = await getSessionToken(bucketId);
			if (!token) {
				token = randomToken();
				await setSessionToken(bucketId, token);
			}

			const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
			const relay = await resolveRelayUrl(fallback);
			relayUrl = relay;
			client = new RelayClient(relay, bucketId, token);
			client.onStatus = (s, detail) => {
				status = detail ? `${s}: ${detail}` : s;
				if (s === 'closed' && detail === 'bucket full') {
					bucketFull = true;
					client?.close();
					client = null;
				}
			};
			client.onControl = (msg) => {
				if (msg.t === 'slot' && typeof msg.n === 'number') slot = msg.n;
				if (msg.t === 'peer_join') {
					peerPresent = true;
					notifyPartnerJoined(bucketId);
				}
				if (msg.t === 'peer_leave') peerPresent = false;
			};
			client.onBinary = async (buf) => {
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
					queueMicrotask(scrollBottom);
				} catch (e) {
					console.warn('byteln: decrypt failed', e);
					error = 'Received bytes but could not decrypt — both sides need the same #key= in the URL.';
				}
			};
			client.connect();
		} catch (e) {
			error = e instanceof Error ? e.message : 'failed to start';
		}
	});

	async function enableNotifications() {
		notifyPerm = await ensureNotifyPermission();
	}
	onDestroy(() => client?.close());

	function scrollBottom() {
		listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
	}

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
		queueMicrotask(scrollBottom);
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
			<div class="meta">
				<span class="id">{bucketId}</span>
				<span class="pill" class:on={peerPresent}
					>{peerPresent ? 'partner here' : 'waiting for partner'}</span
				>
				<span class="stat">{status}</span>
				{#if relayUrl}
					<span class="stat" title="Relay">{relayUrl}</span>
				{/if}
			</div>
			<div class="actions">
				<button type="button" onclick={copyShare}>{shareOpen ? 'Copied' : 'Share link'}</button>
				<button type="button" onclick={doExport}>Export</button>
				{#if notifyPerm === 'default'}
					<button type="button" onclick={enableNotifications}>Enable alerts</button>
				{:else if notifyPerm === 'granted'}
					<span class="stat">alerts on</span>
				{/if}
			</div>
		</header>

		{#if error}
			<p class="err">{error}</p>
		{/if}

		<div class="list" bind:this={listEl}>
			{#each messages as m (m.id)}
				<article class:self={m.from === 'self'}>
					<span class="who">{m.from === 'self' ? 'You' : 'Partner'}</span>
					<p>{m.body}</p>
					<time>{new Date(m.ts).toLocaleTimeString()}</time>
				</article>
			{/each}
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
					disabled={!key || !!error}
				></textarea>
				<button type="submit" disabled={!draft.trim() || !key || !!error}>Send</button>
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
		align-items: center;
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

	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
		font-size: 0.85rem;
		color: var(--muted);
	}

	.id {
		font-family: ui-monospace, monospace;
		color: var(--ink);
	}

	.pill {
		border: 1px solid var(--line);
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
	}

	.pill.on {
		border-color: var(--accent-dim);
		color: var(--accent);
	}

	.actions {
		display: flex;
		gap: 0.4rem;
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

	.err {
		flex-shrink: 0;
		color: var(--danger);
		margin: 0;
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
