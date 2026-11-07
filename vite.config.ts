import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const BASE = '/HugoChineseAPP/';

// Identifies this build, so offline warm-up runs once per app version.
const APP_VERSION = process.env.GITHUB_SHA?.slice(0, 8) ?? String(Date.now());

export default defineConfig({
  base: BASE,
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    VitePWA({
      // The app registers the worker itself (src/lib/pwa.ts) to show "New version" and reload when idle.
      // skipWaiting + clientsClaim stay on: a prompt-style waiting worker would never activate for copies
      // that still run the old code, which cannot send SKIP_WAITING.
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        name: 'Hugo 中文',
        short_name: 'Hugo 中文',
        description: 'Chinese vocabulary and grammar from your own Excel file',
        lang: 'en',
        start_url: BASE,
        scope: BASE,
        display: 'standalone',
        background_color: '#f6f2ea',
        theme_color: '#b8322a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,json,webmanifest}'],
        globIgnores: ['hw/**', 'dict/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallbackDenylist: [/\/hw\//, /\/dict\//],
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/hw/'),
            handler: 'CacheFirst',
            options: { cacheName: 'strokes', expiration: { maxEntries: 12000 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/dict/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'dictionary' },
          },
        ],
      },
    }),
  ],
  test: { environment: 'node' },
});
