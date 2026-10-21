// @vitest-environment node
// (esbuild, importato da vite, non funziona sotto jsdom)
import { describe, it, expect, vi } from 'vitest';

const captured = vi.hoisted(() => ({ opts: null as any })); // eslint-disable-line @typescript-eslint/no-explicit-any -- cattura le opzioni del plugin

vi.mock('vite-plugin-pwa', () => ({
  VitePWA: (opts: unknown) => {
    captured.opts = opts;
    return [];
  },
}));

describe('vite.config runtimeCaching[0].urlPattern', () => {
  it('escluso vault e sottoalbero /api/notes/, incluso il resto, anche dopo la serializzazione', async () => {
    await import('../../vite.config');
    const fn = captured.opts.workbox.runtimeCaching[0].urlPattern as (a: { url: URL }) => boolean;
    expect(typeof fn).toBe('function');
    // stessa serializzazione di workbox generateSW: la funzione deve essere autosufficiente
    const rebuilt = new Function('return ' + fn.toString())() as typeof fn;
    const match = (p: string) => rebuilt({ url: new URL('https://notiq.test' + p) });
    expect(match('/api/notes')).toBe(true);
    expect(match('/api/notes/abc')).toBe(false);
    expect(match('/api/notes/abc/versions')).toBe(false);
    expect(match('/api/vault/keyring')).toBe(false);
    expect(match('/api/notebooks')).toBe(true);
    expect(match('/uploads/x.png')).toBe(false);
  });
});
