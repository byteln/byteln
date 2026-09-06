<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { env } from '$env/dynamic/public';
	import ConversationTabs from '$lib/components/ConversationTabs.svelte';
	import DeviceSettings from '$lib/components/DeviceSettings.svelte';
	import { APP_NAME, SECURE_LINE } from '$lib/brand';
	import {
		buildRoomHash,
		createPinVerifier,
		generatePinSalt,
		generateRoomPin,
		stashCreatorPin
	} from '$lib/crypto/room';
	import {
		exportKeyRaw,
		generateSessionKey,
		randomBucketId
	} from '$lib/crypto/session';
	import { connectionManager } from '$lib/relay/connection-manager';
	import { defaultRelayUrl, loadDirectory, pingServer, type DirectoryServer } from '$lib/servers/directory';
	import { defaultNickname, resolveRelayUrl, setRelayUrl } from '$lib/storage/history';
	import { onMount } from 'svelte';

	let relay = $state('');
	let servers = $state<DirectoryServer[]>([]);
	let health = $state<Record<string, boolean | null>>({});
	let busy = $state(false);

	const relayHost = $derived.by(() => {
		const raw = relay.trim();
		if (!raw) return 'relay';
		try {
			return new URL(raw.replace(/^ws/i, 'http')).hostname;
		} catch {
			return raw.replace(/^wss?:\/\//i, '').split('/')[0] || 'relay';
		}
	});

	const relayHealth = $derived(health[relay.trim()] ?? null);
	const selectedServer = $derived(servers.find((s) => s.url.replace(/\/$/, '') === relay.trim().replace(/\/$/, '')));

	onMount(async () => {
		const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
		relay = await resolveRelayUrl(fallback);
		servers = await loadDirectory(env.PUBLIC_DIRECTORY_URL || '/directory/servers.json');
		await pingAll();

		const createIntent =
			page.url.searchParams.get('create') === '1' || page.url.searchParams.get('new') === '1';
		if (createIntent) {
			const url = new URL(page.url);
			url.searchParams.delete('create');
			url.searchParams.delete('new');
			history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
			await startChat();
		}
	});

	async function pingAll() {
		const urls = new Set(servers.map((s) => s.url));
		if (relay.trim()) urls.add(relay.trim());
		for (const url of urls) {
			health[url] = null;
			void pingServer(url).then((ok) => {
				health[url] = ok;
			});
		}
	}

	async function persistRelay() {
		const url = relay.trim();
		if (!url) return;
		await setRelayUrl(url);
		if (health[url] === undefined) {
			health[url] = null;
			health[url] = await pingServer(url);
		}
	}

	async function startChat() {
		busy = true;
		try {
			await persistRelay();
			const id = randomBucketId();
			const key = await generateSessionKey();
			const raw = await exportKeyRaw(key);
			const pin = generateRoomPin();
			const salt = generatePinSalt();
			const pv = await createPinVerifier(pin, salt, id);
			const hash = buildRoomHash({ keyRaw: raw, pv, salt, seat: 0 });
			stashCreatorPin(id, pin);
			await connectionManager.registerRoom({
				bucketId: id,
				roomHash: hash,
				relayUrl: relay.trim(),
				roomPin: pin,
				nickname: defaultNickname(id),
				isCreator: true
			});
			await goto(`/b/${id}${hash}`);
		} finally {
			busy = false;
		}
	}

	async function selectServer(url: string) {
		relay = url;
		await persistRelay();
	}
</script>

<svelte:head>
	<title>{APP_NAME} — your secure lines</title>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="screen">
	<header class="topbar">
		<div class="brand">
			<svg width="20" height="20" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
				<line x1="10" y1="20" x2="30" y2="20" stroke="#34D399" stroke-width="3" />
				<circle cx="10" cy="20" r="5.5" fill="#090B0D" stroke="#34D399" stroke-width="3" />
				<circle cx="30" cy="20" r="5.5" fill="#090B0D" stroke="#34D399" stroke-width="3" />
			</svg>
			{APP_NAME}
		</div>
		<div class="relay-pill">
			<span class={['dot', relayHealth === false && 'down']} aria-hidden="true"></span>
			{relayHost}
		</div>
	</header>

	<div class="content">
		<h1>Your secure lines</h1>
		<p class="intro">
			Start a new line or open one you already have. Nothing here lives anywhere but this device.
		</p>

		<ConversationTabs variant="home" />

		<div class="actions">
			<button type="button" class="btn-new" disabled={busy} onclick={startChat}>
				<svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
					<path d="M10 4v12M4 10h12" stroke="#06120D" stroke-width="2" stroke-linecap="round" />
				</svg>
				{busy ? 'Opening…' : `New ${SECURE_LINE}`}
			</button>
			<a class="btn-import" href="/import">
				<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
					<path
						d="M10 3v10m0 0l-4-4m4 4l4-4M4 16h12"
						stroke="currentColor"
						stroke-width="1.6"
						stroke-linecap="round"
						stroke-linejoin="round"
					/>
				</svg>
				Import history
			</a>
		</div>

		<section class="relay-section" aria-label="Relay server">
			<label class="list-label" for="relay">Relay URL</label>
			<div class="relay-field">
				<input
					id="relay"
					bind:value={relay}
					placeholder="wss://byteln.com"
					autocomplete="off"
					spellcheck="false"
					onblur={() => void persistRelay()}
				/>
				<button type="button" class="refresh" aria-label="Check relay" onclick={() => void pingAll()}>
					<svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
						<path
							d="M16 10a6 6 0 11-2-4.47M16 4v4h-4"
							stroke="currentColor"
							stroke-width="1.6"
							stroke-linecap="round"
							stroke-linejoin="round"
						/>
					</svg>
				</button>
			</div>
			<p class="relay-meta">
				{#if relayHealth === true}
					<span class="ok">●</span> connected
				{:else if relayHealth === false}
					<span class="down">●</span> unreachable
				{:else}
					<span class="wait">●</span> checking
				{/if}
				{#if selectedServer}
					· {selectedServer.name}
				{:else}
					· public relay
				{/if}
			</p>
			{#if servers.length}
				<ul class="dir">
					{#each servers as s (s.url)}
						<li>
							<button
								type="button"
								class={['dir-item', s.url.replace(/\/$/, '') === relay.trim().replace(/\/$/, '') && 'active']}
								onclick={() => selectServer(s.url)}
							>
								<span class="name">{s.name}</span>
								<span class="meta"
									>{s.region ?? '—'}
									{#if health[s.url] === true}
										· up
									{:else if health[s.url] === false}
										· down
									{/if}
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>

		<DeviceSettings />
	</div>
</div>

<style>
	.screen {
		--bg: #090b0d;
		--surface: #12151a;
		--surface-2: #171b21;
		--line: #232830;
		--text: #eceef1;
		--muted: #98a1ac;
		--dim: #5b6470;
		--accent: #34d399;
		--accent-ink: #06120d;
		--accent-soft: rgba(52, 211, 153, 0.12);
		--ink: #eceef1;
		--accent-dim: rgba(52, 211, 153, 0.12);
		--font-display: 'Inter', sans-serif;
		--font-body: 'Inter', sans-serif;
		--safe-top: env(safe-area-inset-top, 0px);
		--safe-bottom: env(safe-area-inset-bottom, 0px);
		position: relative;
		z-index: 1;
		max-width: 460px;
		margin: 0 auto;
		min-height: 100dvh;
		display: flex;
		flex-direction: column;
		background: var(--bg);
		color: var(--text);
		font-family: 'Inter', sans-serif;
		-webkit-font-smoothing: antialiased;
		font-size: 16px;
	}

	.screen :global(*) {
		-webkit-tap-highlight-color: transparent;
	}

	.screen :global(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.topbar {
		position: sticky;
		top: 0;
		z-index: 10;
		padding: calc(var(--safe-top) + 16px) 20px 14px;
		background: rgba(9, 11, 13, 0.92);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--line);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 8px;
		font-family: 'IBM Plex Mono', monospace;
		font-size: 15.5px;
		font-weight: 500;
		color: #fff;
	}

	.relay-pill {
		display: flex;
		align-items: center;
		gap: 6px;
		font-family: 'IBM Plex Mono', monospace;
		font-size: 11.5px;
		color: var(--dim);
		background: var(--surface);
		border: 1px solid var(--line);
		padding: 5px 10px;
		border-radius: 100px;
		max-width: 46%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.relay-pill .dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--accent);
		flex-shrink: 0;
	}

	.relay-pill .dot.down {
		background: var(--dim);
	}

	.content {
		flex: 1;
		padding: 28px 20px calc(var(--safe-bottom) + 28px);
	}

	h1 {
		font-size: 26px;
		font-weight: 700;
		letter-spacing: -0.01em;
		margin: 0 0 10px;
		color: #fff;
		line-height: 1.2;
	}

	.intro {
		font-size: 14.5px;
		color: var(--muted);
		line-height: 1.6;
		margin: 0 0 28px;
		max-width: 38ch;
	}

	.actions {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin: 0 0 36px;
	}

	.btn-new,
	.btn-import {
		font: inherit;
		cursor: pointer;
		font-weight: 600;
		border-radius: 12px;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		min-height: 48px;
		text-decoration: none;
	}

	.btn-new {
		background: var(--accent);
		color: var(--accent-ink);
		font-size: 15.5px;
		padding: 15px;
		border: none;
	}

	.btn-new:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.btn-import {
		background: transparent;
		border: 1px solid var(--line);
		color: var(--text);
		font-size: 15px;
		padding: 14px;
	}

	.btn-import:active {
		border-color: #3a414b;
	}

	.relay-section {
		border-top: 1px solid var(--line);
		padding-top: 22px;
	}

	.list-label {
		display: block;
		font-size: 12.5px;
		color: var(--dim);
		font-weight: 500;
		margin: 0 0 12px;
		padding: 0 2px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.relay-field {
		display: flex;
		align-items: center;
		gap: 10px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 10px;
		padding: 4px 6px 4px 14px;
		margin-bottom: 10px;
		min-height: 48px;
	}

	.relay-field input {
		flex: 1;
		background: none;
		border: none;
		color: var(--text);
		font-family: 'IBM Plex Mono', monospace;
		font-size: 13.5px;
		outline: none;
		min-width: 0;
		padding: 10px 0;
	}

	.relay-field input::placeholder {
		color: var(--dim);
	}

	.refresh {
		color: var(--dim);
		display: flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		background: none;
		cursor: pointer;
		border-radius: 8px;
		padding: 0;
	}

	.refresh:active {
		background: var(--surface-2);
	}

	.relay-meta {
		font-size: 12px;
		color: var(--dim);
		padding: 0 2px;
		margin: 0 0 12px;
	}

	.relay-meta .ok {
		color: var(--accent);
	}

	.relay-meta .down {
		color: #f87171;
	}

	.relay-meta .wait {
		color: var(--dim);
	}

	.dir {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.dir-item {
		width: 100%;
		text-align: left;
		background: var(--surface);
		border: 1px solid var(--line);
		color: var(--text);
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 1rem;
		padding: 12px 14px;
		min-height: 44px;
		border-radius: 10px;
		font: inherit;
		cursor: pointer;
	}

	.dir-item.active {
		border-color: rgba(52, 211, 153, 0.4);
	}

	.dir-item:active {
		background: var(--surface-2);
	}

	.name {
		font-weight: 600;
		font-size: 14px;
	}

	.meta {
		color: var(--dim);
		font-size: 12.5px;
		font-family: 'IBM Plex Mono', monospace;
		flex-shrink: 0;
	}
</style>
