<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import { onMount } from 'svelte';

	let { children } = $props();

	onMount(() => {
		document.documentElement.dataset.ready = '1';
	});
</script>

<svelte:head>
	<title>byteln</title>
	<meta name="description" content="Ephemeral end-to-end encrypted chat. Two peers. No accounts." />
	<link rel="icon" href={favicon} />
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
