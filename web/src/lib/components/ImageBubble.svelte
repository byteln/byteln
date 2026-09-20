<script lang="ts">
	import type { Attachment } from 'svelte/attachments';

	interface Props {
		mime: string;
		data: Uint8Array;
		w?: number;
		h?: number;
		alt?: string;
		thumb?: boolean;
	}

	let { mime, data, w, h, alt = 'Image', thumb = false }: Props = $props();

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

<img
	class={['bubble-img', thumb && 'thumb']}
	{@attach blobSrc(mime, data)}
	{alt}
	width={w}
	height={h}
/>

<style>
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
</style>
