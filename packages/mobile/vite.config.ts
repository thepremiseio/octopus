import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: '/mobile/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      injectRegister: 'auto',
      devOptions: {
        enabled: true,
        navigateFallbackAllowlist: [/^\/mobile/],
      },
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        id: '/mobile/',
        name: 'Octopus Mobile',
        short_name: 'Octopus',
        description: 'Chat with your Octopus agents',
        theme_color: '#0f0f0f',
        background_color: '#0f0f0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/mobile/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        screenshots: [
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Octopus Mobile — agent chat list',
          },
        ],
        share_target: {
          action: '/mobile/share',
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: {
            title: 'title',
            text: 'text',
            url: 'url',
          },
        },
      },
      workbox: {
        importScripts: ['/mobile/push-sw.js'],
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        navigateFallback: '/mobile/index.html',
        navigateFallbackAllowlist: [/^\/mobile/],
        runtimeCaching: [
          {
            urlPattern: /\/api\/v1\//,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 300 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    allowedHosts: true,
  },
});
