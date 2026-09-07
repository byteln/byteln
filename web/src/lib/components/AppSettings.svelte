<script lang="ts">
	import DeviceSettings from '$lib/components/DeviceSettings.svelte';
	import { env } from '$env/dynamic/public';
	import { defaultRelayUrl, loadDirectory, pingServer, type DirectoryServer } from '$lib/servers/directory';
	import { resolveRelayUrl, setRelayUrl } from '$lib/storage/history';
	import { onMount } from 'svelte';

	type Props = {
		open: boolean;
		onClose: () => void;
	};

	let { open, onClose }: Props = $props();

	let relay = $state('');
	let servers = $state<DirectoryServer[]>([]);
	let health = $state<Record<string, boolean | null>>({});

	const selectedServer = $derived(
		servers.find((s) => s.url.replace(/\/$/, '') === relay.trim().replace(/\/$/, ''))
	);
	const relayHealth = $derived(health[relay.trim()] ?? null);

	onMount(() => {
		void (async () => {
			const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
			relay = await resolveRelayUrl(fallback);
			servers = await loadDirectory(env.PUBLIC_DIRECTORY_URL || '/directory/servers.json');
			await pingAll();
		})();
	});

	function onKeydown(e: KeyboardEvent) {
		if (!open) return;
		if (e.key === 'Escape') onClose();
	}

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

	async function selectServer(url: string) {
		relay = url;
		await persistRelay();
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
	<div class="settings-overlay" role="presentation">
		<button type="button" class="scrim" aria-label="Close settings" onclick={onClose}></button>
		<div
			class="settings-panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			tabindex="-1"
		>
			<header class="settings-header">
				<h2 id="settings-title">Settings</h2>
				<button type="button" class="close" onclick={onClose}>Close</button>
			</header>

			<div class="settings-body">
				<a class="import-link" href="/import" onclick={onClose}>Import history</a>

				<section class="relay-section" aria-label="Relay server">
					<label class="list-label" for="settings-relay">Relay URL</label>
					<div class="relay-field">
						<input
							id="settings-relay"
							bind:value={relay}
							placeholder="wss://byteln.com"
							autocomplete="off"
							spellcheck="false"
							onblur={() => void persistRelay()}
						/>
						<button type="button" class="refresh" aria-label="Check relay" onclick={() => void pingAll()}>
							↻
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
										class={[
											'dir-item',
											s.url.replace(/\/$/, '') === relay.trim().replace(/\/$/, '') && 'active'
										]}
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
	</div>
{/if}

<style>
	.settings-overlay {
		position: fixed;
		inset: 0;
		z-index: 280;
		display: flex;
		align-items: flex-end;
		justify-content: center;
	}

	@media (min-width: 720px) {
		.settings-overlay {
			align-items: center;
			padding: 1rem;
		}
	}

	.scrim {
		position: absolute;
		inset: 0;
		border: none;
		padding: 0;
		margin: 0;
		background: rgba(0, 0, 0, 0.55);
		cursor: default;
	}

	.settings-panel {
		position: relative;
		z-index: 1;
		width: min(28rem, 100%);
		max-height: min(85dvh, 40rem);
		display: flex;
		flex-direction: column;
		background: var(--bg1, #101317);
		border: 1px solid var(--line);
		border-radius: 0.75rem 0.75rem 0 0;
		padding-bottom: env(safe-area-inset-bottom, 0px);
		box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.35);
	}

	@media (min-width: 720px) {
		.settings-panel {
			border-radius: 0.75rem;
			padding-bottom: 0;
		}
	}

	.settings-header {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 1rem 1.15rem 0.85rem;
		border-bottom: 1px solid var(--line);
	}

	.settings-header h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 1.15rem;
	}

	.close {
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.4rem 0.7rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
		font-size: 0.88rem;
	}

	.settings-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 1rem 1.15rem 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}

	.import-link {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 0.75rem 1rem;
		border-radius: 0.45rem;
		border: 1px solid var(--line);
		color: var(--accent);
		text-decoration: none;
		font-weight: 600;
		font-size: 0.92rem;
	}

	.list-label {
		display: block;
		font-size: 0.72rem;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--muted);
		margin-bottom: 0.45rem;
	}

	.relay-field {
		display: flex;
		gap: 0.4rem;
	}

	.relay-field input {
		flex: 1;
		font: inherit;
		font-size: 0.85rem;
		padding: 0.55rem 0.65rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(10, 12, 14, 0.6);
		color: var(--ink);
	}

	.refresh {
		font: inherit;
		cursor: pointer;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--muted);
		border-radius: 0.35rem;
		padding: 0 0.7rem;
	}

	.relay-meta {
		margin: 0.45rem 0 0;
		font-size: 0.8rem;
		color: var(--muted);
	}

	.ok {
		color: var(--accent);
	}
	.down {
		color: var(--danger, #f87171);
	}
	.wait {
		color: var(--muted);
	}

	.dir {
		list-style: none;
		margin: 0.65rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}

	.dir-item {
		width: 100%;
		text-align: left;
		font: inherit;
		cursor: pointer;
		padding: 0.65rem 0.75rem;
		border-radius: 0.4rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.dir-item.active {
		border-color: rgba(61, 220, 176, 0.45);
		background: rgba(61, 220, 176, 0.08);
	}

	.dir-item .name {
		font-weight: 600;
		font-size: 0.9rem;
	}

	.dir-item .meta {
		font-size: 0.78rem;
		color: var(--muted);
	}
</style>
