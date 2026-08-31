<script lang="ts">
	import { APP_NAME, SECURE_LINE } from '$lib/brand';
	import SignatureMark from '$lib/components/SignatureMark.svelte';

	type Props = {
		onContinue: () => void;
	};

	let { onContinue }: Props = $props();

	const steps = [
		{
			title: 'Set an app PIN',
			body: 'Required once on this device. It locks your chat list and saved links — not stored on any server.'
		},
		{
			title: `Start or join a ${SECURE_LINE}`,
			body: 'Create a line and share the link + room PIN with one person, or open a link they sent you.'
		},
		{
			title: 'Chat privately',
			body: 'Messages are end-to-end encrypted. The relay only passes encrypted data — it never sees your keys or PINs.'
		}
	];
</script>

<div class="intro">
	<div class="lockup" aria-label={APP_NAME}>
		<SignatureMark size={96} />
		<p class="brand">{APP_NAME}</p>
	</div>
	<h1>Private chat for two people</h1>
	<p class="lede">
		No accounts, no message history on the server. Everything you save stays on this device only.
	</p>

	<section class="how" aria-labelledby="how-title">
		<h2 id="how-title">How it works</h2>
		<ol class="steps">
			{#each steps as step, i}
				<li>
					<span class="step-num" aria-hidden="true">{i + 1}</span>
					<div class="step-body">
						<strong>{step.title}</strong>
						<p>{step.body}</p>
					</div>
				</li>
			{/each}
		</ol>
	</section>

	<p class="next">Tap continue to set up or unlock your app PIN.</p>
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
		max-width: 20ch;
	}

	.lede {
		margin: 0;
		color: var(--muted);
		font-size: 1.05rem;
		line-height: 1.55;
		max-width: 42ch;
	}

	.how {
		margin-top: 0.25rem;
	}

	.how h2 {
		margin: 0 0 0.75rem;
		font-size: 0.8rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted);
	}

	.steps {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.85rem;
	}

	.steps li {
		display: flex;
		gap: 0.85rem;
		align-items: flex-start;
		padding: 0.85rem 1rem;
		border-radius: 0.5rem;
		border: 1px solid var(--line);
		background: rgba(18, 26, 23, 0.45);
	}

	.step-num {
		flex-shrink: 0;
		width: 1.65rem;
		height: 1.65rem;
		display: grid;
		place-items: center;
		border-radius: 999px;
		background: var(--accent-dim);
		color: var(--accent);
		font-size: 0.85rem;
		font-weight: 700;
	}

	.step-body strong {
		display: block;
		font-size: 0.95rem;
		margin-bottom: 0.2rem;
	}

	.step-body p {
		margin: 0;
		font-size: 0.88rem;
		line-height: 1.45;
		color: var(--muted);
	}

	.next {
		margin: 0;
		font-size: 0.9rem;
		color: var(--muted);
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
	}

	@media (prefers-reduced-motion: reduce) {
		.intro {
			animation: none;
		}
	}
</style>
