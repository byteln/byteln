<script lang="ts">
	import { APP_NAME } from '$lib/brand';
	import SignatureMark from '$lib/components/SignatureMark.svelte';

	type Props = {
		onContinue: () => void;
	};

	let { onContinue }: Props = $props();
</script>

<div class="intro">
	<div class="lockup" aria-label={APP_NAME}>
		<SignatureMark size={96} />
		<p class="brand">{APP_NAME}</p>
	</div>
	<h1>Two devices. One secure line. Nothing on the relay.</h1>
	<p class="lede">
		End-to-end encrypted chat for two people. Your messages and chat list stay on this device
		only — the relay never sees keys or room PINs.
	</p>
	<ul class="points">
		<li>Share a link and room PIN separately with your partner</li>
		<li>Protect saved chats with an app PIN on this device</li>
		<li>No accounts — just a secure line between you two</li>
	</ul>
	<button type="button" class="primary" onclick={onContinue}>Continue</button>
</div>

<style>
	.intro {
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
		max-width: 40ch;
	}

	.points {
		margin: 0;
		padding-left: 1.2rem;
		color: var(--muted);
		font-size: 0.95rem;
		line-height: 1.6;
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.primary {
		align-self: flex-start;
		font: inherit;
		cursor: pointer;
		border-radius: 0.35rem;
		padding: 0.75rem 1.2rem;
		border: none;
		background: var(--accent);
		color: #06110d;
		font-weight: 600;
		margin-top: 0.5rem;
	}

	@media (prefers-reduced-motion: reduce) {
		.intro {
			animation: none;
		}
	}
</style>
