import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const h = vi.hoisted(() => ({
  user: null as null | { role?: string },
  clock: 0,
  deriveS: vi.fn(),
  reset: vi.fn(),
  sync: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('../../../store/authStore', () => ({
  useAuthStore: (sel: (s: { user: unknown }) => unknown) => sel({ user: h.user }),
}));
vi.mock('../../../utils/argon2', () => ({
  DEFAULT_KDF: { m: 65536, t: 3, p: 1 },
  deriveS: h.deriveS,
  resetArgon2Worker: h.reset,
}));
// Stand-in di AppLayout: chiama il hook di sync mockato e rende l'Outlet, senza trascinare db/api.
vi.mock('../../../hooks/useSync', () => ({ useSync: () => h.sync() }));
vi.mock('../../../components/layout/AppLayout', async () => {
  const { Outlet } = await import('react-router-dom');
  const { useSync } = await import('../../../hooks/useSync');
  function LayoutStub() { useSync(); return <div data-testid="layout"><Outlet /></div>; }
  return { default: LayoutStub };
});
vi.mock('../../../lib/db', () => { throw new Error('db vietato'); });
vi.mock('../../../lib/api', () => { throw new Error('api vietata'); });

import VaultBenchPage from '../VaultBenchPage';

const setSecure = (v: boolean) =>
  Object.defineProperty(window, 'isSecureContext', { value: v, configurable: true });

function mount() {
  return render(
    <MemoryRouter initialEntries={['/admin/vault-bench']}>
      <Routes>
        <Route path="/admin/vault-bench" element={<VaultBenchPage />} />
        <Route path="/login" element={<div>LOGIN</div>} />
        <Route path="/notes" element={<div>NOTES</div>} />
        <Route path="/admin" element={<div>ADMIN</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const json = () => JSON.parse((screen.getByRole('textbox', { name: 'vaultBench.output' }) as HTMLTextAreaElement).value);

async function settle() {
  for (let i = 0; i < 400; i++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    if (!/running/.test(screen.getByRole('status').textContent ?? '')) return;
  }
}

async function finish() {
  fireEvent.click(screen.getByRole('button', { name: 'vaultBench.start' }));
  await settle();
}

describe('VaultBenchPage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    h.user = { role: 'SUPERADMIN' };
    h.clock = 0;
    h.deriveS.mockReset();
    h.reset.mockReset();
    h.sync.mockReset();
    vi.spyOn(performance, 'now').mockImplementation(() => h.clock);
    setSecure(true);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('senza utente reindirizza a /login', () => {
    h.user = null;
    mount();
    expect(screen.getByText('LOGIN')).toBeInTheDocument();
  });

  it('ruolo USER reindirizza a /notes e non chiama deriveS', () => {
    h.user = { role: 'USER' };
    mount();
    expect(screen.getByText('NOTES')).toBeInTheDocument();
    expect(h.deriveS).not.toHaveBeenCalled();
  });

  it('SUPERADMIN vede la pagina; senza secure context Avvia e disabilitato', () => {
    mount();
    expect(screen.getByRole('button', { name: 'vaultBench.start' })).toBeEnabled();
    setSecure(false);
    mount();
    expect(screen.getAllByRole('button', { name: 'vaultBench.start' }).at(-1)).toBeDisabled();
  });

  it('corsa completa: statistiche, ordine reset/deriveS, nessun accesso vietato', async () => {
    const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('ls'); });
    const open = vi.fn(() => { throw new Error('caches'); });
    Object.defineProperty(globalThis, 'caches', { value: { open }, configurable: true });
    let call = 0;
    h.deriveS.mockImplementation(async () => {
      const k = call++ % 23;
      h.clock += k < 3 ? [100, 300, 200][k] : (k - 2) * 10;
      return new Uint8Array(32);
    });
    mount();
    await finish();

    const out = json();
    expect(out.status).toBe('done');
    expect(out.DEFAULT_KDF).toEqual({ m: 65536, t: 3, p: 1 });
    expect(out).toHaveProperty('entry');
    expect(out.results.map((r: { t: number }) => r.t)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    for (const r of out.results) {
      expect(r.n).toBe(20);
      expect(r.p95).toBe(190); // 19o di 20 valori ordinati
      expect(r.median).toBe(105);
      expect(r.cold.samples).toEqual([100, 300, 200]);
      expect(r.cold.worst).toBe(300);
      expect(r.errors).toBe(0);
    }
    expect(setItem).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    // Ordine: ogni deriveS a freddo e preceduta da un reset arrivato dopo la deriveS precedente.
    const resets = h.reset.mock.invocationCallOrder;
    const derives = h.deriveS.mock.invocationCallOrder;
    expect(resets).toHaveLength(24);
    derives.forEach((d, i) => {
      if (i % 23 >= 3) return;
      const prev = i === 0 ? -Infinity : derives[i - 1];
      expect(resets.some((r) => r < d && r > prev)).toBe(true);
    });
    // Fra due deriveS a caldo consecutive non c'e' nessun reset.
    derives.forEach((d, i) => {
      if (i % 23 <= 3) return;
      expect(resets.some((r) => r > derives[i - 1] && r < d)).toBe(false);
    });
  });

  it('un t che viola un vincolo ferma la sequenza', async () => {
    h.deriveS.mockImplementation(async (_p: string, _s: unknown, params: { t: number }) => {
      h.clock += params.t >= 5 ? 1600 : 50;
      return new Uint8Array(32);
    });
    mount();
    await finish();
    const out = json();
    expect(out.status).toBe('violated');
    expect(out.results.map((r: { t: number }) => r.t)).toEqual([3, 4, 5]);
    expect(out.results[2].violated).toBe(true);
    expect(out.results[1].violated).toBe(false);
  });

  it('errore a freddo: un retry e campo retries', async () => {
    let call = 0;
    h.deriveS.mockImplementation(async () => {
      if (call++ === 0) throw new Error('kdfFailed');
      h.clock += 10;
      return new Uint8Array(32);
    });
    mount();
    await finish();
    const out = json();
    expect(out.results[0].retries).toBe(1);
    expect(out.results[0].errors).toBe(0);
    expect(out.results[0].cold.samples).toHaveLength(3);
  });

  it('JSON incrementale e Stop', async () => {
    let call = 0;
    let atThird = 0;
    h.deriveS.mockImplementation(async () => {
      call++;
      if (call === 3) atThird = json().results[0].cold.samples.length;
      if (call === 6) fireEvent.click(screen.getByRole('button', { name: 'vaultBench.stop' }));
      h.clock += 10;
      return new Uint8Array(32);
    });
    mount();
    await finish();
    expect(atThird).toBeGreaterThanOrEqual(1);
    const out = json();
    expect(out.status).toBe('stopped');
    expect(call).toBe(6);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].warm).toHaveLength(3);
  });

  it('entry: legge il nome dello script modulo index-*.js', async () => {
    const sc = document.createElement('script');
    sc.type = 'module';
    sc.src = '/assets/index-AbC123.js';
    document.head.appendChild(sc);
    try {
      mount();
      expect(json().entry).toBe('index-AbC123.js');
    } finally {
      sc.remove();
    }
  });

  it('smontaggio a meta corsa: deriveS non viene piu chiamato', async () => {
    const { unmount } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'vaultBench.start' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); }); // dentro lo sleep a freddo
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(h.deriveS).not.toHaveBeenCalled();
  });

  it('Stop: reset del Worker, derivazione in volo rifiutata, nessuna violazione', async () => {
    let rejectInFlight: ((e: Error) => void) | null = null;
    let call = 0;
    h.reset.mockImplementation(() => { rejectInFlight?.(new Error('worker reset')); rejectInFlight = null; });
    h.deriveS.mockImplementation(() => {
      if (++call === 5) return new Promise((_, rej) => { rejectInFlight = rej; });
      h.clock += 10;
      return Promise.resolve(new Uint8Array(32));
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'vaultBench.start' }));
    for (let i = 0; i < 100 && call < 5; i++) await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(call).toBe(5);
    const resetsBefore = h.reset.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'vaultBench.stop' }));
    expect(h.reset.mock.calls.length).toBe(resetsBefore + 1);
    await settle();
    const out = json();
    expect(out.status).toBe('stopped');
    expect(call).toBe(5);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].errors).toBe(0);
    expect(out.results[0].violated).toBe(false);
    expect(out.results[0].warm).toHaveLength(1);
  });

  it('campioni a freddo oltre il limite a t=4: violated, solo t=3 e t=4', async () => {
    let cold = false;
    h.reset.mockImplementation(() => { cold = true; });
    h.deriveS.mockImplementation(async (_p: string, _s: unknown, params: { t: number }) => {
      h.clock += params.t === 4 && cold ? 2100 : 50;
      cold = false;
      return new Uint8Array(32);
    });
    mount();
    await finish();
    const out = json();
    expect(out.status).toBe('violated');
    expect(out.results.map((r: { t: number }) => r.t)).toEqual([3, 4]);
    expect(out.results[0].violated).toBe(false);
    expect(out.results[1].violated).toBe(true);
    expect(out.results[1].cold.worst).toBe(2100);
  });

  it('deriveS rifiuta sempre a t=3: retries 1, errors 1, nessun caldo, violated', async () => {
    h.deriveS.mockRejectedValue(new Error('kdfFailed'));
    mount();
    await finish();
    const out = json();
    expect(out.status).toBe('violated');
    expect(out.results).toHaveLength(1);
    const r = out.results[0];
    expect(r.t).toBe(3);
    expect(r.retries).toBe(1);
    expect(r.errors).toBe(1);
    expect(r.warm).toEqual([]);
    expect(r.violated).toBe(true);
  });

  it('la rotta sta fuori da AppLayout: App non invoca il sync del layout', async () => {
    vi.useRealTimers(); // il lazy + findBy non avanzano con i fake timer
    h.user = { role: 'SUPERADMIN' };
    const { default: App } = await import('../../../App');
    render(
      <MemoryRouter initialEntries={['/admin/vault-bench']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText('vaultBench.title')).toBeInTheDocument();
    expect(screen.queryByTestId('layout')).toBeNull();
    expect(h.sync).not.toHaveBeenCalled();
  });
});
