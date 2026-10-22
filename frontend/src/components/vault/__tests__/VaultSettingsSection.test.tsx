import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { n?: number }) => (o?.n != null ? `${k}:${o.n}` : k) }) }));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

type Row = { id: string; userId: string; isVault?: boolean; syncStatus?: string };
const h = vi.hoisted(() => ({
  auth: { user: { id: 'u1' } as { id: string } | null },
  vault: { byUser: {} as Record<string, unknown>, unlockedUserId: null as string | null },
  notes: [] as { id: string; userId: string; isVault?: boolean; syncStatus?: string }[],
  tags: [] as { id: string; userId: string; isVault?: boolean; syncStatus?: string }[],
  queue: [] as { entityId: string; userId: string; status?: string }[],
  queueCalls: 0,
  lateItem: null as { entityId: string; userId: string } | null,
}));
vi.mock('../../../store/authStore', () => ({ useAuthStore: (sel: (s: unknown) => unknown) => sel(h.auth) }));
vi.mock('../../../store/vaultStore', () => ({ useVaultStore: (sel: (s: unknown) => unknown) => sel(h.vault) }));
vi.mock('../../../lib/vaultSession', () => ({ setOfflineUnlock: vi.fn(async () => {}), removeFromDevice: vi.fn(async () => {}) }));
vi.mock('../../../lib/db', () => {
  const table = (rows: () => Row[]) => ({
    filter: (f: (r: never) => boolean) => ({ primaryKeys: async () => rows().filter((r) => f(r as never)).map((r) => r.id) }),
    bulkDelete: async (ids: string[]) => {
      const keep = rows().filter((r) => !ids.includes(r.id));
      rows().splice(0, rows().length, ...keep);
    },
  });
  return {
    db: {
      notes: table(() => h.notes),
      tags: table(() => h.tags),
      syncQueue: {
        where: () => {
          h.queueCalls += 1;
          if (h.lateItem && h.queueCalls === 2) h.queue.push(h.lateItem); // l'item compare fra controllo e conferma
          return { equals: (u: string) => ({ filter: (f: (i: never) => boolean) => ({ toArray: async () => h.queue.filter((i) => i.userId === u && f(i as never)) }) }) };
        },
      },
      transaction: async (_m: string, ..._rest: unknown[]) => (_rest[_rest.length - 1] as () => Promise<unknown>)(),
    },
  };
});

import VaultSettingsSection from '../VaultSettingsSection';
import { removeFromDevice, setOfflineUnlock } from '../../../lib/vaultSession';

const cache = (over: object = {}) => ({ status: 'READY', epoch: 1, offlineUnlock: false, ...over });
const renderIt = () => render(<MemoryRouter><VaultSettingsSection /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  h.auth.user = { id: 'u1' };
  h.vault.byUser = { u1: cache() };
  h.vault.unlockedUserId = null;
  h.notes.splice(0, h.notes.length, { id: 'v1', userId: 'u1', isVault: true, syncStatus: 'synced' }, { id: 'n1', userId: 'u1', syncStatus: 'synced' });
  h.tags.splice(0, h.tags.length);
  h.queue.splice(0, h.queue.length);
  h.queueCalls = 0;
  h.lateItem = null;
});

describe('VaultSettingsSection', () => {
  it('mostra "Come funziona" e il link a /vault; il link porta a /vault', () => {
    renderIt();
    expect(screen.getByText('vault.settings.howTitle')).toBeTruthy();
    expect(screen.getByText('vault.settings.openVault').getAttribute('href')).toBe('/vault');
  });

  it('senza cache locale niente switch ne rimozione', () => {
    h.vault.byUser = {};
    renderIt();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('vault.settings.removeButton')).toBeNull();
  });

  it("lo switch chiama setOfflineUnlock con il valore opposto e ha un'area di tocco di 44 px", async () => {
    renderIt();
    const sw = screen.getByRole('switch');
    expect(sw.className).toContain('min-h-[44px]');
    expect(sw.className).toContain('min-w-[44px]');
    fireEvent.click(sw);
    await waitFor(() => expect(setOfflineUnlock).toHaveBeenCalledWith('u1', true));
  });

  it('il controllo del reconcile non sta qui, nemmeno da sbloccato (sta nello sheet)', () => {
    h.vault.unlockedUserId = 'u1';
    renderIt();
    expect(screen.queryByText('vault.settings.checkButton')).toBeNull();
  });

  it('rimozione rifiutata con item di coda sulle note vault: niente dialog, niente cancellazione', async () => {
    h.queue.push({ entityId: 'v1', userId: 'u1' });
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeBlocked:1')).toBeTruthy());
    expect(screen.queryByText('vault.settings.removeConfirmTitle')).toBeNull();
    expect(removeFromDevice).not.toHaveBeenCalled();
    expect(h.notes.map((n) => n.id)).toEqual(['v1', 'n1']);
  });

  it('un item di coda failed blocca come uno pending', async () => {
    h.queue.push({ entityId: 'v1', userId: 'u1', status: 'failed' });
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeBlocked:1')).toBeTruthy());
    expect(removeFromDevice).not.toHaveBeenCalled();
  });

  it('riga vault non synced senza item di coda (riga sporca): blocca, niente cancellazione', async () => {
    h.notes[0].syncStatus = 'updated';
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeBlocked:1')).toBeTruthy());
    expect(screen.queryByText('vault.settings.removeConfirmTitle')).toBeNull();
    expect(h.notes.map((n) => n.id)).toEqual(['v1', 'n1']);
  });

  it('tag vault non synced blocca; una nota NON vault non synced no', async () => {
    h.tags.push({ id: 'g1', userId: 'u1', isVault: true, syncStatus: 'created' });
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeBlocked:1')).toBeTruthy());

    h.tags.splice(0, h.tags.length);
    h.notes[1].syncStatus = 'updated';
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeConfirmTitle')).toBeTruthy());
  });

  it('un item di coda su una nota NON vault non blocca', async () => {
    h.queue.push({ entityId: 'n1', userId: 'u1' });
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeConfirmTitle')).toBeTruthy());
  });

  it('conferma: removeFromDevice e cancella solo le righe vault (note e tag)', async () => {
    h.tags.push({ id: 'g1', userId: 'u1', isVault: true, syncStatus: 'synced' }, { id: 'g2', userId: 'u1', syncStatus: 'synced' });
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeConfirmTitle')).toBeTruthy());
    fireEvent.click(screen.getAllByText('vault.settings.removeButton')[1]);
    await waitFor(() => expect(removeFromDevice).toHaveBeenCalledWith('u1'));
    expect(h.notes.map((n) => n.id)).toEqual(['n1']);
    expect(h.tags.map((g) => g.id)).toEqual(['g2']);
  });

  it('item comparso dopo la conferma: removeFromDevice non parte, niente cancellazione, banner di blocco', async () => {
    h.lateItem = { entityId: 'v1', userId: 'u1' };
    renderIt();
    fireEvent.click(screen.getByText('vault.settings.removeButton'));
    await waitFor(() => expect(screen.getByText('vault.settings.removeConfirmTitle')).toBeTruthy());
    fireEvent.click(screen.getAllByText('vault.settings.removeButton')[1]);
    await waitFor(() => expect(screen.getByText('vault.settings.removeBlocked:1')).toBeTruthy());
    expect(removeFromDevice).not.toHaveBeenCalled();
    expect(h.notes.map((n) => n.id)).toEqual(['v1', 'n1']);
  });
});
