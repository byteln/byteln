<script lang="ts">
	import ShareQr from '$lib/components/ShareQr.svelte';
	import { shareRoomHash } from '$lib/crypto/room';
	import { connectionManager } from '$lib/relay/connection-manager';
	import { inviteText, shareInvite } from '$lib/share';
	import { getRoom, type RoomRecord } from '$lib/storage/history';
	import { onMount } from 'svelte';

	type Props = {
		bucketId: string;
		compact?: boolean;
	};

	let { bucketId, compact = false }: Props = $props();

	let room = $state<RoomRecord | null>(null);
	let roomPin = $state<string | null>(null);
	let appPin = $state('');
	let error = $state('');
	let busy = $state(false);
	let copied = $state(false);
	let shareBusy = $state<'qr' | 'invite' | null>(null);
	let shareFlash = $state<'qr' | 'invite' | null>(null);
	let needsAppPin = $state(false);
	let unrecoverable = $state(false);

	onMount(() => {
		void load();
	});

	async function load() {
		error = '';
		room = await getRoom(bucketId);
		if (!room?.isCreator) return;

		const pin = await connectionManager.getRoomPin(bucketId);
		if (pin) {
			roomPin = pin;
			needsAppPin = false;
			return;
		}

		if (room.credentialsEnc) {
			needsAppPin = true;
			return;
		}

		unrecoverable = true;
	}

	async function revealWithAppPin() {
		busy = true;
		error = '';
		try {
			if (!/^\d{4,8}$/.test(appPin)) {
				error = 'Enter your 4–8 digit app PIN.';
				return;
			}
			const pin = await connectionManager.revealRoomPin(bucketId, appPin);
			if (!pin) {
				error = 'Wrong app PIN, or room PIN was never saved on this device.';
				return;
			}
			roomPin = pin;
			needsAppPin = false;
			appPin = '';
		} finally {
			busy = false;
		}
	}

	function shareUrl(): string {
		if (!room?.roomHash) return `${location.origin}/b/${bucketId}`;
		const hash = room.roomHash.startsWith('#') ? room.roomHash : `#${room.roomHash}`;
		return `${location.origin}/b/${bucketId}${shareRoomHash(hash)}`;
	}

	async function copyPin() {
		if (!roomPin) return;
		await navigator.clipboard.writeText(roomPin);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	async function copyShareAndPin() {
		if (!roomPin) return;
		await navigator.clipboard.writeText(inviteText(shareUrl(), roomPin));
		copied = true;
		setTimeout(() => (copied = false), 1500);
	}

	function flashShare(kind: 'qr' | 'invite') {
		shareFlash = kind;
		setTimeout(() => {
			if (shareFlash === kind) shareFlash = null;
		}, 1500);
	}

	async function shareQr() {
		if (!roomPin || shareBusy) return;
		shareBusy = 'qr';
		try {
			const result = await shareInvite({
				url: shareUrl(),
				pin: roomPin,
				withQr: true,
				qrFilename: `byteln-${bucketId}-qr.png`
			});
			if (result !== 'cancelled') flashShare('qr');
		} finally {
			shareBusy = null;
		}
	}

	async function shareInviteText() {
		if (!roomPin || shareBusy) return;
		shareBusy = 'invite';
		try {
			const result = await shareInvite({
				url: shareUrl(),
				pin: roomPin,
				withQr: false
			});
			if (result !== 'cancelled') flashShare('invite');
		} finally {
			shareBusy = null;
		}
	}
</script>

{#if room?.isCreator && !room.legacy}
	<div class="share-invite" class:compact>
		{#if !compact}
			<h3 class="title">Share link and PIN</h3>
		{/if}

		{#if roomPin}
			<p class="hint">Share the link and PIN separately — never paste the PIN into the URL.</p>
			<p class="pin-display" aria-label="Room PIN">{roomPin}</p>
			<ShareQr value={shareUrl()} compact />
			<div class="actions">
				<button type="button" class="inline-btn" disabled={shareBusy !== null} onclick={() => void shareQr()}>
					{shareFlash === 'qr' ? 'Shared' : shareBusy === 'qr' ? 'Sharing…' : 'Share QR'}
				</button>
				<button
					type="button"
					class="inline-btn primary"
					disabled={shareBusy !== null}
					onclick={() => void shareInviteText()}
				>
					{shareFlash === 'invite'
						? 'Shared'
						: shareBusy === 'invite'
							? 'Sharing…'
							: 'Share link + PIN'}
				</button>
				<button type="button" class="inline-btn" onclick={copyPin}>{copied ? 'Copied' : 'Copy PIN'}</button>
				<button type="button" class="inline-btn" onclick={copyShareAndPin}>
					{copied ? 'Copied' : 'Copy link + PIN'}
				</button>
			</div>
		{:else if needsAppPin}
			<p class="hint">Enter your app PIN to reveal the saved room PIN for this chat.</p>
			<form
				class="reveal-form"
				onsubmit={(e) => {
					e.preventDefault();
					void revealWithAppPin();
				}}
			>
				<input
					type="password"
					inputmode="numeric"
					pattern="[0-9]*"
					maxlength="8"
					autocomplete="current-password"
					placeholder="App PIN"
					bind:value={appPin}
				/>
				<button type="submit" class="inline-btn primary" disabled={busy}>
					{busy ? 'Checking…' : 'Reveal room PIN'}
				</button>
			</form>
			{#if error}
				<p class="err" role="alert">{error}</p>
			{/if}
		{:else if unrecoverable}
			<p class="hint warn">
				The room PIN was not saved on this device. You cannot recover it — start a new chat and
				share fresh link + PIN.
			</p>
		{/if}
	</div>
{/if}

<style>
	.share-invite {
		margin-top: 0.5rem;
		padding-top: 0.65rem;
		border-top: 1px dashed var(--line);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}

	.share-invite.compact {
		margin-top: 0;
		padding-top: 0;
		border-top: none;
	}

	.title {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.hint {
		margin: 0;
		font-size: 0.8rem;
		color: var(--muted);
		line-height: 1.45;
	}

	.hint.warn {
		color: var(--danger);
	}

	.pin-display {
		margin: 0;
		font-family: ui-monospace, monospace;
		font-size: 1.25rem;
		letter-spacing: 0.14em;
		font-weight: 600;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
	}

	.reveal-form {
		display: flex;
		flex-wrap: wrap;
		gap: 0.45rem;
		align-items: center;
	}

	.reveal-form input {
		font: inherit;
		padding: 0.45rem 0.6rem;
		border-radius: 0.3rem;
		border: 1px solid var(--line);
		background: rgba(10, 12, 14, 0.6);
		color: var(--ink);
		width: min(8rem, 100%);
	}

	.inline-btn {
		font: inherit;
		font-size: 0.78rem;
		cursor: pointer;
		border: 1px solid var(--line);
		background: transparent;
		color: var(--accent);
		border-radius: 0.3rem;
		padding: 0.35rem 0.6rem;
	}

	.inline-btn.primary {
		background: var(--accent);
		color: #06110d;
		border-color: var(--accent);
		font-weight: 600;
	}

	.inline-btn:disabled {
		opacity: 0.6;
		cursor: wait;
	}

	.err {
		margin: 0;
		color: var(--danger);
		font-size: 0.8rem;
	}
</style>
