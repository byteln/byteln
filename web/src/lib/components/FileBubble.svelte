<script lang="ts">
	interface Props {
		name: string;
		size: number;
		data?: Uint8Array | null;
		/** 0..1 while transferring; null hides the bar. */
		progress?: number | null;
		/** Short status line under the name (e.g. "Waiting for partner…"). */
		status?: string;
	}

	let { name, size, data = null, progress = null, status = '' }: Props = $props();

	/** Extensions that can run code or render active content when opened. */
	const RISKY_EXTENSIONS = new Set([
		'apk', 'app', 'bat', 'cmd', 'com', 'cpl', 'dll', 'dmg', 'docm', 'exe', 'hta', 'htm', 'html',
		'jar', 'js', 'jse', 'lnk', 'mjs', 'msi', 'pkg', 'potm', 'pptm', 'ps1', 'reg', 'scr', 'sh',
		'svg', 'vbe', 'vbs', 'wsf', 'xhtml', 'xlsm'
	]);

	const ext = $derived(name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '');
	const risky = $derived(RISKY_EXTENSIONS.has(ext));
	const percent = $derived(
		progress != null ? Math.round(Math.min(1, Math.max(0, progress)) * 100) : null
	);
	const canDownload = $derived(!!data && progress == null);

	function formatSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	function download() {
		if (!data) return;
		if (
			risky &&
			!confirm(
				`"${name}" can run code on your device. Only open it if you trust your partner and expected this file. Download anyway?`
			)
		) {
			return;
		}
		const copy = new Uint8Array(data.byteLength);
		copy.set(data);
		// Generic type: the browser saves it instead of rendering it in this origin.
		const url = URL.createObjectURL(new Blob([copy], { type: 'application/octet-stream' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.rel = 'noopener';
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}
</script>

<div class="file-card">
	<div class="file-icon" aria-hidden="true">
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none">
			<path
				d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z"
				stroke="currentColor"
				stroke-width="1.6"
				stroke-linejoin="round"
			/>
			<path d="M14 3v5h5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" />
		</svg>
		{#if ext}
			<span class="ext">{ext.slice(0, 4)}</span>
		{/if}
	</div>
	<div class="file-body">
		<span class="file-name" title={name}>{name}</span>
		<span class="file-meta">
			{formatSize(size)}
			{#if percent != null}· {percent}%{/if}
			{#if status}· {status}{/if}
		</span>
		{#if percent != null}
			<div class="file-track" aria-hidden="true">
				<div class="file-bar" style:width="{percent}%"></div>
			</div>
		{/if}
		{#if risky && canDownload}
			<span class="file-warn">May contain code — open only if trusted</span>
		{/if}
	</div>
	{#if canDownload}
		<button type="button" class="file-dl" aria-label="Download {name}" onclick={download}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path
					d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14"
					stroke="currentColor"
					stroke-width="1.8"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
		</button>
	{/if}
</div>

<style>
	.file-card {
		display: flex;
		align-items: center;
		gap: 0.65rem;
		min-width: min(15rem, 100%);
		max-width: 100%;
		padding: 0.55rem 0.6rem;
		border-radius: 0.35rem;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--line, rgba(255, 255, 255, 0.08));
	}

	.file-icon {
		position: relative;
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.4rem;
		height: 2.4rem;
		border-radius: 0.3rem;
		background: rgba(61, 220, 176, 0.1);
		color: var(--accent, #3ddcb0);
	}

	.ext {
		position: absolute;
		bottom: 0.1rem;
		font-size: 0.5rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
	}

	.file-body {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
	}

	.file-name {
		font-size: 0.9rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.file-meta {
		font-size: 0.72rem;
		color: var(--muted);
	}

	.file-warn {
		font-size: 0.68rem;
		color: var(--danger, #f87171);
	}

	.file-track {
		height: 0.22rem;
		margin-top: 0.15rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.12);
		overflow: hidden;
	}

	.file-bar {
		height: 100%;
		border-radius: inherit;
		background: var(--accent, #3ddcb0);
		transition: width 0.15s ease;
	}

	.file-dl {
		flex-shrink: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.2rem;
		height: 2.2rem;
		border-radius: 999px;
		border: 1px solid var(--line, rgba(255, 255, 255, 0.12));
		background: transparent;
		color: var(--accent, #3ddcb0);
		cursor: pointer;
	}

	.file-dl:hover {
		background: rgba(61, 220, 176, 0.1);
	}
</style>
