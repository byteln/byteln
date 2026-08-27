<script lang="ts">
	import { goto } from '$app/navigation';
	import { env } from '$env/dynamic/public';
	import SignatureMark from '$lib/components/SignatureMark.svelte';
	import {
		exportKeyRaw,
		generateSessionKey,
		keyToFragment,
		randomBucketId
	} from '$lib/crypto/session';
	import { defaultRelayUrl, loadDirectory, pingServer, type DirectoryServer } from '$lib/servers/directory';
	import { resolveRelayUrl, setRelayUrl } from '$lib/storage/history';
	import { onMount } from 'svelte';

	let relay = $state('');
	let servers = $state<DirectoryServer[]>([]);
	let health = $state<Record<string, boolean | null>>({});
	let busy = $state(false);
	let joinId = $state('');

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
			const frag = keyToFragment(raw);
			await goto(`/b/${id}#key=${frag}`);
		} finally {
			busy = false;
		}
	}

	async function joinChat() {
		const id = joinId.trim().toLowerCase();
		if (!id) return;
		await persistRelay();
		await goto(`/b/${id}`);
	}

	function selectServer(url: string) {
		relay = url;
	}
</script>

<main class="home">
	<div class="lockup" aria-label="byteln">
		<SignatureMark size={96} />
		<p class="brand">byteln</p>
	</div>
	<h1>Two devices. Encrypted bytes. Nothing stored.</h1>
	<p class="lede">
		A self-hostable relay that never sees plaintext. Create a bucket, share the link — the key lives
		only in the URL fragment.
	</p>

	<div class="cta">
		<button type="button" class="primary" disabled={busy} onclick={startChat}>
			{busy ? 'Opening…' : 'New chat'}
		</button>
		<a class="ghost" href="/import">Import history</a>
	</div>

	<section class="server" aria-label="Relay server">
		<label for="relay">Relay URL</label>
		<input id="relay" bind:value={relay} placeholder="wss://byteln.dev" autocomplete="off" />
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

	<section class="join" aria-label="Join existing">
		<label for="join">Or join by bucket ID</label>
		<div class="row">
			<input id="join" bind:value={joinId} placeholder="xk3n9d2a" autocomplete="off" />
			<button type="button" class="secondary" onclick={joinChat}>Join</button>
		</div>
		<p class="hint">If you have a full share link, open it directly — it includes the key.</p>
	</section>
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

	.lockup {
		display: flex;
		align-items: center;
		gap: 1rem;
		flex-wrap: wrap;
	}

	.brand {
		font-family: var(--font-display);
		font-weight: 800;
		font-size: clamp(2.8rem, 10vw, 4.5rem);
		letter-spacing: -0.04em;
		line-height: 0.95;
		margin: 0;
		background: linear-gradient(120deg, var(--ink) 30%, var(--accent));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}

	h1 {
		font-family: var(--font-display);
		font-weight: 700;
		font-size: clamp(1.35rem, 3.5vw, 1.85rem);
		line-height: 1.2;
		margin: 0;
		max-width: 18ch;
	}

	.lede {
		margin: 0;
		color: var(--muted);
		font-size: 1.05rem;
		line-height: 1.55;
		max-width: 36ch;
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

	.secondary {
		background: transparent;
		color: var(--ink);
		border-color: var(--line);
	}

	.server,
	.join {
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

	.row {
		display: flex;
		gap: 0.5rem;
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
