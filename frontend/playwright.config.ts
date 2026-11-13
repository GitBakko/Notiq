import { defineConfig, devices } from '@playwright/test';

// La porta e' configurabile: in locale la 5173 puo' essere di un altro progetto e `reuseExistingServer` farebbe girare i test sull'app sbagliata.
const PORT = process.env.E2E_PORT ?? '5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    locale: 'en',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    // Chiave root di test del vault (solo dev server, mai in build); va col backend avviato con VAULT_E2E=1.
    env: { VITE_VAULT_E2E: '1' },
  },
});
