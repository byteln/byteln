<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { pwaInfo } from 'virtual:pwa-info';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		document.documentElement.dataset.ready = '1';

		if (pwaInfo) {
			void import('virtual:pwa-register').then(({ registerSW }) => {
				registerSW({ immediate: true });
			});
		}
	});
</script>

<svelte:head>
	<title>byteln</title>
	<meta name="description" content="Ephemeral end-to-end encrypted chat. Two peers. No accounts." />
	<meta name="theme-color" content="#0A0C0E" />
	<link rel="icon" href={favicon} />
	{#if pwaInfo}
		<link rel="manifest" href="/manifest.webmanifest" />
	{/if}
</svelte:head>

{@render children()}

<style>
	:global(*, *::before, *::after) {
		box-sizing: border-box;
	}

	:global(html, body) {
		margin: 0;
		min-height: 100%;
		background: #090b0d;
		color: #eceef1;
	}
</style>
