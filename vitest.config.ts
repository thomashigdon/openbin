import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  define: {
    __EE__: JSON.stringify(false),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Isolate each test file in a VM context inside long-lived workers instead of a fresh
    // happy-dom environment per file: ~2x faster (66s -> 33s on 6 cores). VM workers hold on to
    // memory, so recycle each one past 250MB (about +1.5GB peak for the suite).
    pool: 'vmForks',
    vmMemoryLimit: '250MB',
  },
})
