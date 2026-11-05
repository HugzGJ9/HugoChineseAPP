import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const BASE = '/HugoChineseAPP/';

export default defineConfig({
  base: BASE,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
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
        globIgnores: ['hw/**'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallbackDenylist: [/\/hw\//],
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/hw/'),
            handler: 'CacheFirst',
            options: { cacheName: 'strokes', expiration: { maxEntries: 12000 } },
          },
        ],
      },
    }),
  ],
  test: { environment: 'node' },
});
