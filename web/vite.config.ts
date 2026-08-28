import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter({
				fallback: 'index.html',
				precompress: false,
				strict: false
			})
		}),
		SvelteKitPWA({
			registerType: 'autoUpdate',
			manifest: {
				name: 'byteln',
				short_name: 'byteln',
				description: 'Ephemeral end-to-end encrypted chat relay',
				theme_color: '#0A0C0E',
				background_color: '#0A0C0E',
				display: 'standalone',
				start_url: '/',
				icons: [
					{
						src: '/pwa-192.png',
						sizes: '192x192',
						type: 'image/png'
					},
					{
						src: '/pwa-512.png',
						sizes: '512x512',
						type: 'image/png'
					}
				]
			},
			workbox: {
				globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}']
			}
		})
	]
});
