<script lang="ts">
	import { goto } from '$app/navigation';
	import { env } from '$env/dynamic/public';
	import {
		importHistory,
		type ExportFile,
		type StoredMessage
	} from '$lib/crypto/backup';
	import { parseRoomFragment } from '$lib/crypto/room';
	import { connectionManager } from '$lib/relay/connection-manager';
	import { base64UrlToBytes, importKeyRaw, keyFromFragment, keyToFragment } from '$lib/crypto/session';
	import { defaultRelayUrl } from '$lib/servers/directory';
	import { defaultNickname, mergeMessages, resolveRelayUrl } from '$lib/storage/history';
	import { APP_NAME } from '$lib/brand';
	import { bumpRooms } from '$lib/stores/conversations';

	let file = $state<ExportFile | null>(null);
	let passphrase = $state('');
	let keyFrag = $state('');
	let error = $state('');
	let ok = $state('');
	let imported = $state<StoredMessage[]>([]);
	let bucketId = $state('');

	async function onFile(e: Event) {
		error = '';
		ok = '';
		const input = e.target as HTMLInputElement;
		const f = input.files?.[0];
		if (!f) return;
		try {
			file = JSON.parse(await f.text()) as ExportFile;
			bucketId = file.bucket_id;
		} catch {
			error = 'Could not parse export file';
			file = null;
		}
	}

	async function runImport() {
		if (!file) return;
		error = '';
		try {
			let sessionKey: CryptoKey | null = null;
			const fromHash = keyFromFragment(keyFrag.startsWith('#') ? keyFrag : `#key=${keyFrag}`);
			const raw =
				fromHash ??
				(keyFrag ? null : keyFromFragment(location.hash));
			if (raw) {
				sessionKey = await importKeyRaw(raw);
			} else if (keyFrag && !keyFrag.includes('=')) {
				sessionKey = await importKeyRaw(base64UrlToBytes(keyFrag.replace(/^key=/, '')));
			}

			const result = await importHistory(file, sessionKey, passphrase || undefined);
			await mergeMessages(result.bucketId, result.messages);
			imported = result.messages;
			bucketId = result.bucketId;
			ok = `Imported ${result.messages.length} messages for ${result.bucketId}`;
		} catch (e) {
			error = e instanceof Error ? e.message : 'import failed';
		}
	}

	async function reconnect() {
		if (!bucketId) return;
		let frag = location.hash;
		if (keyFrag) {
			const raw = keyFromFragment(keyFrag.startsWith('#') ? keyFrag : `#key=${keyFrag}`);
			if (raw) frag = `#key=${keyToFragment(raw)}`;
			else if (!keyFrag.includes('key=')) frag = `#key=${keyFrag.replace(/^#/, '')}`;
		}
		if (!frag.includes('key=')) {
			error = 'Need session key in fragment to reconnect live.';
			return;
		}
		const fallback = defaultRelayUrl(env.PUBLIC_DEFAULT_RELAY);
		const relayUrl = await resolveRelayUrl(fallback);
		const fragment = parseRoomFragment(frag);
		await connectionManager.registerRoom({
			bucketId,
			roomHash: frag,
			relayUrl,
			nickname: defaultNickname(bucketId),
			isCreator: fragment?.seat === 0
		});
		bumpRooms();
		await goto(`/b/${bucketId}${frag}`);
	}
</script>

<main class="import">
	<a href="/app" class="brand">{APP_NAME}</a>
	<h1>Import history</h1>
	<p class="lede">Decrypt a portable export into this device’s local store.</p>
	<p class="note">To reconnect live, use the full share link (includes <code>#key=</code> and room PIN fields).</p>

	<label class="file">
		<span>Export file</span>
		<input type="file" accept="application/json,.json" onchange={onFile} />
	</label>

	<label>
		<span>Session key (fragment or raw) — optional if passphrase-only</span>
		<input bind:value={keyFrag} placeholder="#key=… or base64url" autocomplete="off" />
	</label>

	<label>
		<span>Passphrase (if used at export)</span>
		<input type="password" bind:value={passphrase} autocomplete="off" />
	</label>

	<button type="button" class="primary" disabled={!file} onclick={runImport}>Import</button>

	{#if error}
		<p class="err">{error}</p>
	{/if}
	{#if ok}
		<p class="ok">{ok}</p>
		<button type="button" onclick={reconnect}>Reconnect to secure line</button>
	{/if}
</main>

<style>
	.import {
		position: relative;
		z-index: 1;
		max-width: 32rem;
		margin: 0 auto;
		padding: 2.5rem 1.5rem 3rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.brand {
		font-family: var(--font-display);
		font-weight: 800;
		font-size: 1.5rem;
		text-decoration: none;
		color: var(--ink);
	}

	h1 {
		font-family: var(--font-display);
		margin: 0;
		font-size: 1.75rem;
	}

	.lede {
		margin: 0;
		color: var(--muted);
	}

	.note {
		margin: 0;
		font-size: 0.9rem;
		color: var(--muted);
		line-height: 1.45;
	}

	.note code {
		font-family: ui-monospace, monospace;
		font-size: 0.85em;
	}

	label {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.85rem;
		color: var(--muted);
	}

	input {
		font: inherit;
		padding: 0.65rem 0.8rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
	}

	.primary {
		font: inherit;
		cursor: pointer;
		align-self: start;
		padding: 0.7rem 1.1rem;
		border: none;
		border-radius: 0.35rem;
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
	}

	.primary:disabled {
		opacity: 0.5;
	}

	button:not(.primary) {
		font: inherit;
		cursor: pointer;
		align-self: start;
		padding: 0.55rem 0.9rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--ink);
	}

	.err {
		color: var(--danger);
	}

	.ok {
		color: var(--accent);
	}
</style>
