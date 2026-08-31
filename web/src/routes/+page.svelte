<script lang="ts">
	import { APP_NAME } from '$lib/brand';

	const steps = [
		{
			num: '01',
			title: 'Open a line',
			body: 'Your device generates a random line and an encryption key that never leaves it. The server only ever sees a random ID — never the key.'
		},
		{
			num: '02',
			title: 'Share it',
			body: "Send the link however you'd share anything else, or just hold up the QR code if you're face to face. Whoever opens it becomes the other side of the line."
		},
		{
			num: '03',
			title: 'Talk',
			body: "Every message is encrypted on your device before it's sent. The relay passes bytes it can't read from one of you to the other."
		},
		{
			num: '04',
			title: 'Close it',
			body: "When you're both gone, the line is deleted from memory. Want to keep the history? Export it, encrypted, before you go — that part is entirely up to you."
		}
	];

	const relaySees = [
		'That two devices connected to the same line',
		'Connection timestamps, for as long as the line is open',
		'The IP addresses of both devices, like any server',
		'How much encrypted data passed through'
	];

	const relayNeverSees = [
		'What either of you actually wrote',
		"The encryption key — it's never transmitted",
		'Who either of you is',
		"Anything, once the line closes — there's nothing left to query"
	];

	const heroPath = 'M60 70 C 150 70, 150 70, 210 70 C 270 70, 270 70, 360 70';
</script>

<svelte:head>
	<title>{APP_NAME} — a line between two people</title>
	<meta
		name="description"
		content="byteln is a line between exactly two people. The server relays what you send and forgets it instantly — no accounts, no chat history stored."
	/>
	<link rel="preconnect" href="https://fonts.googleapis.com" />
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
	<link
		href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap"
		rel="stylesheet"
	/>
</svelte:head>

<div class="page">
	<nav>
		<div class="container nav-row">
			<a href="/" class="brand">
				<svg width="24" height="24" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
					<line x1="10" y1="20" x2="30" y2="20" stroke="#34D399" stroke-width="3" />
					<circle cx="10" cy="20" r="5.5" fill="#090B0D" stroke="#34D399" stroke-width="3" />
					<circle cx="30" cy="20" r="5.5" fill="#090B0D" stroke="#34D399" stroke-width="3" />
				</svg>
				{APP_NAME}
			</a>
			<div class="nav-links">
				<a href="#how" class="hide-mobile">How it works</a>
				<a href="#privacy" class="hide-mobile">Privacy</a>
				<a href="#host" class="hide-mobile">Self-host</a>
				<a href="/app" class="nav-cta">Open app</a>
			</div>
		</div>
	</nav>

	<header class="hero">
		<div class="container">
			<div class="relay-tag"><span class="dot"></span>public relay live at wss://byteln.com</div>

			<h1>Talk to one person. Leave nothing behind.</h1>
			<p class="hero-sub">
				byteln is a line between exactly two people. The server relays what you send and forgets it
				instantly — no accounts, no chat history stored, nothing to hand over even if asked.
			</p>

			<div class="hero-actions">
				<a href="/app" class="btn-primary">Start a secure line</a>
				<a href="#how" class="btn-secondary">See how it works</a>
			</div>

			<div class="hero-mark">
				<svg viewBox="0 0 420 140" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
					<path id="heroPath" d={heroPath} stroke="#232830" stroke-width="1.5" />
					<circle cx="60" cy="70" r="10" fill="#090B0D" stroke="#34D399" stroke-width="2.5" />
					<circle cx="360" cy="70" r="10" fill="#090B0D" stroke="#34D399" stroke-width="2.5" />
					<text x="60" y="102" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="#5B6470">you</text>
					<text x="360" y="102" text-anchor="middle" font-family="IBM Plex Mono, monospace" font-size="11" fill="#5B6470">them</text>
					<circle
						class="pulse-dot"
						r="4"
						fill="#34D399"
						style:offset-path={`path('${heroPath}')`}
					/>
				</svg>
			</div>
		</div>
	</header>

	<section id="how">
		<div class="container">
			<div class="section-head">
				<h2>Four steps, then it's just the two of you</h2>
				<p>No sign-up. No profile. A line exists only while both of you are using it.</p>
			</div>

			<div class="steps">
				{#each steps as step (step.num)}
					<div class="step">
						<div class="step-num mono">{step.num}</div>
						<div>
							<h3>{step.title}</h3>
							<p>{step.body}</p>
						</div>
					</div>
				{/each}
			</div>
		</div>
	</section>

	<section id="privacy">
		<div class="container">
			<div class="section-head">
				<h2>What the server can and can't see</h2>
				<p>Being honest about the boundary matters more than promising there isn't one.</p>
			</div>

			<div class="split">
				<div class="split-col yes">
					<h3>The relay sees</h3>
					<ul>
						{#each relaySees as item (item)}
							<li>{item}</li>
						{/each}
					</ul>
				</div>
				<div class="split-col no">
					<h3>The relay never sees</h3>
					<ul>
						{#each relayNeverSees as item (item)}
							<li>{item}</li>
						{/each}
					</ul>
				</div>
			</div>
		</div>
	</section>

	<section id="host">
		<div class="container">
			<div class="section-head">
				<h2>Run your own relay</h2>
				<p>
					byteln is one binary. Anyone can host it and list it publicly, or keep it private for people
					you trust.
				</p>
			</div>

			<div class="host-grid">
				<div class="code-block">
					<span class="c1"># run it anywhere</span><br />
					<span class="c2">docker</span> run -p 443:443 byteln/relay<br />
					<br />
					<span class="c1"># or build from source</span><br />
					<span class="c2">git</span> clone github.com/byteln/relay<br />
					<span class="c2">go</span> build -o bytelnd<br />
					<span class="c3">./bytelnd --listen :443</span>
				</div>
				<div class="host-note">
					<p>
						Every instance is a dumb relay — no database, nothing written to disk.
						<strong>Public relays</strong> are listed at
						<a href="https://github.com/byteln">github.com/byteln</a> through a pull request, checked
						automatically before it's merged.
					</p>
					<p>Running your own gives you a relay only your people know about, on hardware you control.</p>
				</div>
			</div>
		</div>
	</section>

	<footer>
		<div class="container foot-row">
			<span class="mono">byteln — a line, not a platform</span>
			<div class="foot-links">
				<a href="https://github.com/byteln">GitHub</a>
				<a href="#privacy">Privacy</a>
				<a href="/app">Open app</a>
			</div>
		</div>
	</footer>
</div>

<style>
	.page {
		--bg: #090b0d;
		--surface: #12151a;
		--line: #232830;
		--text: #eceef1;
		--muted: #98a1ac;
		--dim: #5b6470;
		--accent: #34d399;
		--accent-ink: #06120d;
		background: var(--bg);
		color: var(--text);
		font-family: 'Inter', sans-serif;
		-webkit-font-smoothing: antialiased;
		font-size: 16px;
		line-height: 1.5;
		min-height: 100dvh;
	}

	:global(html) {
		scroll-behavior: smooth;
	}

	:global(::selection) {
		background: #34d399;
		color: #06120d;
	}

	a {
		color: inherit;
		text-decoration: none;
	}

	.mono {
		font-family: 'IBM Plex Mono', monospace;
	}

	.container {
		max-width: 920px;
		margin: 0 auto;
		padding: 0 24px;
	}

	.page :global(:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 3px;
	}

	@media (prefers-reduced-motion: reduce) {
		.page :global(*) {
			animation: none !important;
			transition: none !important;
		}
	}

	nav {
		position: sticky;
		top: 0;
		z-index: 50;
		background: rgba(9, 11, 13, 0.86);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--line);
	}

	.nav-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 64px;
	}

	.brand {
		display: flex;
		align-items: center;
		gap: 9px;
		font-family: 'IBM Plex Mono', monospace;
		font-size: 17px;
		font-weight: 500;
		color: #fff;
	}

	.nav-links {
		display: flex;
		align-items: center;
		gap: 28px;
		font-size: 14px;
		color: var(--muted);
	}

	.nav-links a:hover {
		color: var(--text);
	}

	.nav-cta {
		background: var(--accent);
		color: var(--accent-ink);
		padding: 9px 18px;
		border-radius: 8px;
		font-weight: 600;
		font-size: 14px;
	}

	.nav-links .hide-mobile {
		display: none;
	}

	@media (min-width: 720px) {
		.nav-links .hide-mobile {
			display: inline;
		}
	}

	.hero {
		padding: 88px 0 64px;
	}

	.relay-tag {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-family: 'IBM Plex Mono', monospace;
		font-size: 12.5px;
		color: var(--dim);
		background: var(--surface);
		border: 1px solid var(--line);
		padding: 6px 12px;
		border-radius: 100px;
		margin-bottom: 28px;
	}

	.relay-tag .dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--accent);
	}

	h1 {
		font-size: clamp(34px, 6vw, 56px);
		line-height: 1.08;
		letter-spacing: -0.02em;
		font-weight: 700;
		color: #fff;
		margin: 0 0 22px;
		max-width: 14ch;
	}

	.hero-sub {
		font-size: 17px;
		color: var(--muted);
		max-width: 46ch;
		line-height: 1.65;
		margin: 0 0 36px;
	}

	.hero-actions {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
		margin-bottom: 72px;
	}

	.btn-primary {
		background: var(--accent);
		color: var(--accent-ink);
		padding: 13px 24px;
		border-radius: 9px;
		font-weight: 600;
		font-size: 15px;
	}

	.btn-secondary {
		background: transparent;
		color: var(--text);
		padding: 13px 24px;
		border-radius: 9px;
		font-weight: 600;
		font-size: 15px;
		border: 1px solid var(--line);
	}

	.btn-secondary:hover {
		border-color: #3a414b;
	}

	.hero-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 48px 20px;
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 16px;
	}

	.hero-mark svg {
		width: 100%;
		max-width: 420px;
		height: auto;
	}

	.pulse-dot {
		animation: travel 3.4s ease-in-out infinite;
	}

	@keyframes travel {
		0% {
			offset-distance: 0%;
			opacity: 0;
		}
		8% {
			opacity: 1;
		}
		45% {
			opacity: 1;
		}
		50% {
			offset-distance: 100%;
			opacity: 0;
		}
		55% {
			opacity: 0;
		}
		60% {
			opacity: 1;
		}
		92% {
			opacity: 1;
		}
		100% {
			offset-distance: 0%;
			opacity: 0;
		}
	}

	section {
		padding: 76px 0;
		border-top: 1px solid var(--line);
	}

	.section-head {
		max-width: 52ch;
		margin-bottom: 44px;
	}

	.section-head h2 {
		font-size: clamp(24px, 4vw, 32px);
		letter-spacing: -0.01em;
		color: #fff;
		margin: 0 0 14px;
		line-height: 1.2;
	}

	.section-head p {
		color: var(--muted);
		font-size: 15.5px;
		line-height: 1.65;
		margin: 0;
	}

	.steps {
		display: flex;
		flex-direction: column;
	}

	.step {
		display: grid;
		grid-template-columns: 44px 1fr;
		gap: 20px;
		padding: 26px 0;
		border-top: 1px solid var(--line);
	}

	.step:first-child {
		border-top: none;
		padding-top: 0;
	}

	.step:last-child {
		padding-bottom: 0;
	}

	.step-num {
		font-family: 'IBM Plex Mono', monospace;
		font-size: 14px;
		color: var(--accent);
		padding-top: 2px;
	}

	.step h3 {
		font-size: 17px;
		color: var(--text);
		margin: 0 0 8px;
		font-weight: 600;
	}

	.step p {
		font-size: 14.5px;
		color: var(--muted);
		line-height: 1.6;
		margin: 0;
		max-width: 52ch;
	}

	.split {
		display: grid;
		grid-template-columns: 1fr;
		gap: 1px;
		background: var(--line);
		border: 1px solid var(--line);
		border-radius: 12px;
		overflow: hidden;
	}

	@media (min-width: 640px) {
		.split {
			grid-template-columns: 1fr 1fr;
		}
	}

	.split-col {
		background: var(--surface);
		padding: 28px 26px;
	}

	.split-col h3 {
		font-family: 'IBM Plex Mono', monospace;
		font-size: 13px;
		margin: 0 0 18px;
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.split-col.no h3 {
		color: #f87171;
	}

	.split-col.yes h3 {
		color: var(--accent);
	}

	.split-col ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.split-col li {
		font-size: 14.5px;
		color: var(--muted);
		padding: 9px 0;
		border-top: 1px solid var(--line);
		line-height: 1.5;
	}

	.split-col li:first-child {
		border-top: none;
		padding-top: 0;
	}

	.host-grid {
		display: grid;
		grid-template-columns: 1fr;
		gap: 20px;
	}

	@media (min-width: 720px) {
		.host-grid {
			grid-template-columns: 1.1fr 0.9fr;
			align-items: start;
		}
	}

	.code-block {
		background: #08090b;
		border: 1px solid var(--line);
		border-radius: 12px;
		padding: 22px 22px;
		font-family: 'IBM Plex Mono', monospace;
		font-size: 13.5px;
		line-height: 1.85;
		overflow-x: auto;
	}

	.code-block .c1 {
		color: var(--dim);
	}

	.code-block .c2 {
		color: var(--accent);
	}

	.code-block .c3 {
		color: var(--muted);
	}

	.host-note {
		font-size: 14.5px;
		color: var(--muted);
		line-height: 1.7;
	}

	.host-note strong {
		color: var(--text);
		font-weight: 600;
	}

	.host-note a {
		color: var(--accent);
		border-bottom: 1px solid rgba(52, 211, 153, 0.35);
	}

	footer {
		border-top: 1px solid var(--line);
		padding: 36px 0 48px;
	}

	.foot-row {
		display: flex;
		flex-direction: column;
		gap: 16px;
		font-size: 13px;
		color: var(--dim);
	}

	@media (min-width: 640px) {
		.foot-row {
			flex-direction: row;
			justify-content: space-between;
			align-items: center;
		}
	}

	.foot-links {
		display: flex;
		gap: 20px;
	}

	.foot-links a:hover {
		color: var(--muted);
	}
</style>
