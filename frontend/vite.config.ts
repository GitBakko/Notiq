import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { visualizer } from 'rollup-plugin-visualizer'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'fonts/*.woff2'],
      manifest: {
        name: 'Notiq',
        short_name: 'Notiq',
        description: 'Minimal, elegant note-taking app',
        theme_color: '#ffffff',
        background_color: '#218d7c',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-256x256.png',
            sizes: '256x256',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-1024x1024.png',
            sizes: '1024x1024',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-maskable-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024, // 4MB
        navigateFallbackDenylist: [/^\/api/, /^\/uploads/, /^\/ws/],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        importScripts: ['/push-sw.js'],
        runtimeCaching: [{
          urlPattern: ({ url }) => url.pathname.startsWith('/api'),
          handler: 'NetworkFirst',
          options: {
            cacheName: 'api-cache',
            expiration: {
              maxEntries: 100,
              maxAgeSeconds: 60 * 60 * 24 // 1 day
            },
            cacheableResponse: {
              statuses: [0, 200]
            }
          }
        }]
      }
    }),
    ...(process.env.ANALYZE ? [visualizer({
      filename: 'dist/stats.html',
      open: true,
      gzipSize: true,
      brotliSize: true,
    })] : []),
  ],
  build: {
    sourcemap: false, // Don't expose source code in production builds
    chunkSizeWarningLimit: 1000, // ganttExport (exceljs) is ~945KB but lazy-loaded
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-data': ['zustand', '@tanstack/react-query', 'axios', 'dexie', 'dexie-react-hooks', 'i18next', 'react-i18next'],
          'vendor-tiptap': [
            '@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-collaboration',
            '@tiptap/extension-collaboration-cursor', '@tiptap/extension-font-family',
            '@tiptap/extension-image', '@tiptap/extension-link', '@tiptap/extension-table',
            '@tiptap/extension-table-cell', '@tiptap/extension-table-header',
            '@tiptap/extension-table-row', '@tiptap/extension-text-align',
            '@tiptap/extension-text-style', '@tiptap/extension-underline',
            'yjs', 'y-prosemirror', '@hocuspocus/provider',
          ],
          'vendor-dnd': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'vendor-recharts': ['recharts'],
          'vendor-date': ['date-fns'],
          'vendor-crypto': ['crypto-js'],
          'vendor-ui': ['lucide-react', 'react-hot-toast', 'clsx'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/uploads': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
})
