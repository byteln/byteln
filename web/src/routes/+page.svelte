<script lang="ts">
	import { goto } from '$app/navigation';
	import { env } from '$env/dynamic/public';
	import ConversationTabs from '$lib/components/ConversationTabs.svelte';
	import DeviceSettings from '$lib/components/DeviceSettings.svelte';
	import { SECURE_LINE } from '$lib/brand';
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

	onMount(async () => {
		const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
		relay = await resolveRelayUrl(fallback);
		servers = await loadDirectory(env.PUBLIC_DIRECTORY_URL || '/directory/servers.json');
		for (const s of servers) {
			health[s.url] = null;
			pingServer(s.url).then((ok) => {
				health[s.url] = ok;
			});
		}
	});

	async function persistRelay() {
		await setRelayUrl(relay.trim());
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

	function selectServer(url: string) {
		relay = url;
	}
</script>

<main class="home">
	<h1>Your secure lines</h1>
	<p class="lede">Start a new {SECURE_LINE.toLowerCase()} or open one from your list.</p>

	<ConversationTabs variant="home" />

	<div class="cta">
		<button type="button" class="primary" disabled={busy} onclick={startChat}>
			{busy ? 'Opening…' : `New ${SECURE_LINE.toLowerCase()}`}
		</button>
		<a class="ghost" href="/import">Import history</a>
	</div>

	<section class="server" aria-label="Relay server">
		<label for="relay">Relay URL</label>
		<input id="relay" bind:value={relay} placeholder="wss://byteln.com" autocomplete="off" />
		{#if servers.length}
			<ul class="dir">
				{#each servers as s}
					<li>
						<button type="button" class="dir-item" onclick={() => selectServer(s.url)}>
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

	<p class="hint">To join, open the link your partner sent — then enter the room PIN.</p>

	<DeviceSettings />
</main>

<style>
	.home {
		position: relative;
		z-index: 1;
		max-width: 42rem;
		margin: 0 auto;
		padding: clamp(2.5rem, 8vw, 5.5rem) 1.5rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		animation: rise 0.7s ease both;
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(12px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	h1 {
		font-family: var(--font-display);
		font-weight: 700;
		font-size: clamp(1.35rem, 3.5vw, 1.85rem);
		line-height: 1.2;
		margin: 0;
	}

	.lede {
		margin: 0;
		color: var(--muted);
		font-size: 1.05rem;
		line-height: 1.55;
		max-width: 40ch;
	}

	.cta {
		display: flex;
		flex-wrap: wrap;
		gap: 0.75rem;
		align-items: center;
		margin-top: 0.5rem;
	}

	button,
	.ghost {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.75rem 1.2rem;
		border: 1px solid transparent;
		text-decoration: none;
	}

	.primary {
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
		transition: transform 0.2s ease, box-shadow 0.2s ease;
	}

	.primary:hover:not(:disabled) {
		transform: translateY(-1px);
		box-shadow: 0 8px 24px rgba(61, 220, 176, 0.25);
	}

	.primary:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.ghost {
		color: var(--muted);
		border-color: var(--line);
	}

	.server {
		margin-top: 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	label {
		font-size: 0.8rem;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--muted);
	}

	input {
		font: inherit;
		padding: 0.7rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
		width: 100%;
	}

	.dir {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.dir-item {
		width: 100%;
		text-align: left;
		background: rgba(18, 26, 23, 0.55);
		border: 1px solid var(--line);
		color: var(--ink);
		display: flex;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.65rem 0.85rem;
	}

	.name {
		font-weight: 600;
	}

	.meta {
		color: var(--muted);
		font-size: 0.85rem;
	}

	.hint {
		margin: 0;
		font-size: 0.85rem;
		color: var(--muted);
	}

	@media (prefers-reduced-motion: reduce) {
		.home {
			animation: none;
		}
	}
</style>
