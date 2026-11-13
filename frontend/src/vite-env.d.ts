/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' solo nelle sessioni E2E (dev server): abilita la chiave root di test, mai in build. */
  readonly VITE_VAULT_E2E?: string;
}
