<script lang="ts">
	import { goto } from '$app/navigation';
	import AppIntro from '$lib/components/AppIntro.svelte';
	import { registerAppSession } from '$lib/app-session';
	import { connectionManager } from '$lib/relay/connection-manager';
	import {
		createVault,
		hasVault,
		isVaultUnlocked,
		lockVault,
		unlockVault
	} from '$lib/crypto/vault';
	import { bumpRooms } from '$lib/stores/conversations';
	import { clearAllLocalData, hasSeenIntro, markIntroSeen } from '$lib/storage/history';
	import { onMount } from 'svelte';

	type Props = {
		children: import('svelte').Snippet;
	};

	let { children }: Props = $props();

	type Mode = 'loading' | 'intro' | 'unlock' | 'setup' | 'ready';

	let mode = $state<Mode>('loading');
	let pin = $state('');
	let confirmPin = $state('');
	let error = $state('');
	let busy = $state(false);

	onMount(() => {
		const unregister = registerAppSession({
			lock: lockApp,
			clearAll: wipeAllLocal
		});

		void (async () => {
			if (isVaultUnlocked()) {
				mode = 'ready';
				await connectionManager.restoreAll();
				return;
			}
			// Existing installs skip intro; only first visit (or after clear all) shows it.
			if ((await hasVault()) && !(await hasSeenIntro())) {
				await markIntroSeen();
			}
			if (!(await hasSeenIntro())) {
				mode = 'intro';
				return;
			}
			mode = (await hasVault()) ? 'unlock' : 'setup';
		})();

		return unregister;
	});

	async function continueFromIntro() {
		await markIntroSeen();
		mode = (await hasVault()) ? 'unlock' : 'setup';
	}

	async function lockApp() {
		await connectionManager.releaseAllConnections();
		lockVault();
		mode = (await hasVault()) ? 'unlock' : 'setup';
	}

	async function wipeAllLocal() {
		connectionManager.clearAll();
		lockVault();
		await clearAllLocalData();
		bumpRooms();
		mode = 'intro';
		await goto('/');
	}

	async function doUnlock() {
		busy = true;
		error = '';
		try {
			const ok = await unlockVault(pin);
			if (!ok) {
				error = 'Wrong app PIN.';
				return;
			}
			mode = 'ready';
			pin = '';
			await connectionManager.persistAllCredentials();
			await connectionManager.restoreAll();
		} finally {
			busy = false;
		}
	}

	async function doSetup() {
		busy = true;
		error = '';
		try {
			if (!/^\d{4,8}$/.test(pin)) {
				error = 'App PIN must be 4–8 digits.';
				return;
			}
			if (pin !== confirmPin) {
				error = 'PINs do not match.';
				return;
			}
			await createVault(pin);
			mode = 'ready';
			pin = '';
			confirmPin = '';
			await connectionManager.persistAllCredentials();
			await connectionManager.restoreAll();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not create vault';
		} finally {
			busy = false;
		}
	}
</script>

{#if mode === 'loading'}
	<div class="gate" aria-busy="true">
		<p>Loading…</p>
	</div>
{:else if mode === 'intro'}
	<AppIntro onContinue={() => void continueFromIntro()} />
{:else if mode === 'unlock'}
	<div class="gate" role="dialog" aria-labelledby="unlock-title">
		<h1 id="unlock-title">Unlock byteln</h1>
		<p class="lede">Enter your app PIN to open saved chats on this device.</p>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				void doUnlock();
			}}
		>
			<input
				type="password"
				inputmode="numeric"
				pattern="[0-9]*"
				maxlength="8"
				autocomplete="current-password"
				placeholder="App PIN"
				bind:value={pin}
			/>
			{#if error}
				<p class="err" role="alert">{error}</p>
			{/if}
			<button type="submit" class="primary" disabled={busy}>Unlock</button>
		</form>
	</div>
{:else if mode === 'setup'}
	<div class="gate" role="dialog" aria-labelledby="setup-title">
		<h1 id="setup-title">Create app PIN</h1>
		<p class="lede">
			Required to start or join secure lines. Protects saved chat links on this device — the relay
			never sees your PIN or keys.
		</p>
		<form
			onsubmit={(e) => {
				e.preventDefault();
				void doSetup();
			}}
		>
			<input
				type="password"
				inputmode="numeric"
				pattern="[0-9]*"
				maxlength="8"
				autocomplete="new-password"
				placeholder="New app PIN (4–8 digits)"
				bind:value={pin}
			/>
			<input
				type="password"
				inputmode="numeric"
				pattern="[0-9]*"
				maxlength="8"
				autocomplete="new-password"
				placeholder="Confirm PIN"
				bind:value={confirmPin}
			/>
			{#if error}
				<p class="err" role="alert">{error}</p>
			{/if}
			<button type="submit" class="primary" disabled={busy}>Save PIN</button>
		</form>
	</div>
{:else}
	{@render children()}
{/if}

<style>
	.gate {
		position: relative;
		z-index: 1;
		max-width: 22rem;
		margin: 0 auto;
		padding: clamp(3rem, 12vw, 6rem) 1.5rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}

	.gate h1 {
		font-family: var(--font-display);
		font-size: 1.75rem;
		margin: 0;
	}

	.lede {
		margin: 0;
		color: var(--muted);
		line-height: 1.5;
		font-size: 0.95rem;
	}

	form {
		display: flex;
		flex-direction: column;
		gap: 0.65rem;
	}

	input {
		font: inherit;
		padding: 0.7rem 0.85rem;
		border-radius: 0.35rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.8);
		color: var(--ink);
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

	.primary:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.err {
		margin: 0;
		color: var(--danger);
		font-size: 0.9rem;
	}
</style>
