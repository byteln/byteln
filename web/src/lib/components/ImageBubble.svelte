<script lang="ts">
	import type { Attachment } from 'svelte/attachments';

	interface Props {
		mime?: string;
		data?: Uint8Array | null;
		w?: number;
		h?: number;
		alt?: string;
		thumb?: boolean;
		/** 0..1 when set (including 0); null/undefined hides the overlay. */
		progress?: number | null;
		/** Force placeholder box even if data is present. */
		placeholder?: boolean;
	}

	let {
		mime = 'image/jpeg',
		data = null,
		w,
		h,
		alt = 'Image',
		thumb = false,
		progress = null,
		placeholder = false
	}: Props = $props();

	const hasData = $derived(!!data && data.byteLength > 0);
	const isPlaceholder = $derived(placeholder || !hasData);
	const showProgress = $derived(progress != null);
	const percent = $derived(showProgress ? Math.round(Math.min(1, Math.max(0, progress ?? 0)) * 100) : 0);
	const hasAspect = $derived(!!(w && h && w > 0 && h > 0));
	const boxStyle = $derived(hasAspect ? `aspect-ratio: ${w} / ${h};` : '');
	const progressLabel = $derived(showProgress ? `${alt}, ${percent}%` : alt);

	function blobSrc(mimeType: string, bytes: Uint8Array): Attachment<HTMLImageElement> {
		return (node) => {
			const copy = new Uint8Array(bytes.byteLength);
			copy.set(bytes);
			const objectUrl = URL.createObjectURL(new Blob([copy], { type: mimeType }));
			node.src = objectUrl;
			return () => {
				URL.revokeObjectURL(objectUrl);
			};
		};
	}
</script>

{#if isPlaceholder}
	<div
		class={['bubble-placeholder', thumb && 'thumb', !thumb && !hasAspect && 'square']}
		style={boxStyle}
		role="img"
		aria-label={progressLabel}
	>
		{#if showProgress}
			<div class="progress-fill" style:height="{percent}%" aria-hidden="true"></div>
			<span class="progress-label" aria-hidden="true">{percent}%</span>
		{/if}
	</div>
{:else if data}
	<div class={['bubble-wrap', thumb && 'thumb']}>
		<img
			class={['bubble-img', thumb && 'thumb']}
			{@attach blobSrc(mime, data)}
			{alt}
			width={w}
			height={h}
		/>
		{#if showProgress}
			<div class="progress-overlay" aria-hidden="true">
				<div class="progress-track">
					<div class="progress-bar" style:width="{percent}%"></div>
				</div>
				<span class="progress-label">{percent}%</span>
			</div>
		{/if}
	</div>
{/if}

<style>
	.bubble-wrap {
		position: relative;
		display: inline-block;
		max-width: 100%;
		line-height: 0;
		border-radius: 0.25rem;
		overflow: hidden;
	}

	.bubble-wrap.thumb {
		flex-shrink: 0;
	}

	.bubble-img {
		display: block;
		max-width: 100%;
		max-height: 20rem;
		object-fit: contain;
		border-radius: 0.25rem;
	}

	.bubble-img.thumb {
		max-width: 2.5rem;
		max-height: 2.5rem;
		width: 2.5rem;
		height: 2.5rem;
		object-fit: cover;
		border-radius: 0.2rem;
		flex-shrink: 0;
	}

	.bubble-placeholder {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: min(100%, 12rem);
		max-height: 20rem;
		border-radius: 0.25rem;
		background: rgba(255, 255, 255, 0.06);
		overflow: hidden;
	}

	.bubble-placeholder.square {
		aspect-ratio: 1;
		min-height: 12rem;
	}

	.bubble-placeholder.thumb {
		width: 2.5rem;
		height: 2.5rem;
		min-height: 2.5rem;
		max-height: 2.5rem;
		border-radius: 0.2rem;
		flex-shrink: 0;
		aspect-ratio: auto;
	}

	.progress-fill {
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		background: rgba(61, 220, 176, 0.28);
		pointer-events: none;
		transition: height 0.15s ease;
	}

	.progress-overlay {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		justify-content: flex-end;
		gap: 0.35rem;
		padding: 0.45rem;
		background: rgba(8, 12, 10, 0.45);
		pointer-events: none;
	}

	.progress-track {
		height: 0.28rem;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.18);
		overflow: hidden;
	}

	.progress-bar {
		height: 100%;
		border-radius: inherit;
		background: var(--accent, #3ddcb0);
		transition: width 0.15s ease;
	}

	.progress-label {
		position: relative;
		z-index: 1;
		align-self: center;
		font-size: 0.75rem;
		font-weight: 600;
		letter-spacing: 0.02em;
		color: var(--ink, #e8f0ec);
		text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
		line-height: 1;
	}

	.bubble-placeholder .progress-label {
		position: absolute;
	}

	.bubble-wrap.thumb .progress-overlay,
	.bubble-placeholder.thumb .progress-fill {
		display: none;
	}

	.bubble-wrap.thumb .progress-label,
	.bubble-placeholder.thumb .progress-label {
		font-size: 0.55rem;
	}
</style>
