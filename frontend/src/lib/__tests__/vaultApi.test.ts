import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AxiosError } from 'axios';

const request = vi.fn();
vi.mock('../api', () => ({ default: { request: (...a: unknown[]) => request(...a) } }));

import * as vaultApi from '../vaultApi';

const fail = (p: Promise<unknown>) =>
  p.then(
    () => {
      throw new Error('resolved');
    },
    // toMatchObject su istanze di Error confronta solo message/name: estraggo i campi in un oggetto semplice
    (e: unknown) => ({ ...(e as object) }) as Record<string, unknown>,
  );

function axErr(status: number, message?: string, headers: Record<string, string> = {}) {
  const e = new AxiosError('x');
  e.response = { status, data: message ? { message } : {}, headers, statusText: '', config: {} as never };
  return e;
}

beforeEach(() => {
  request.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('vaultApi errori', () => {
  it.each([
    [400, 'invalid'],
    [403, 'forbidden'],
    [409, 'conflict'],
    [422, 'rejected'],
    [429, 'rateLimited'],
    [503, 'unavailable'],
  ])('mappa %i -> %s con la chiave del server', async (status, kind) => {
    request.mockRejectedValue(axErr(status, 'errors.vault.k'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ status, kind, key: 'errors.vault.k' });
  });

  it('fallback chiave su 400 e 503 senza body', async () => {
    request.mockRejectedValueOnce(axErr(400));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ key: 'errors.vault.invalidPayload' });
    request.mockRejectedValueOnce(axErr(503));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ key: 'errors.vault.unavailable' });
  });

  it('401 mappato unauthorized', async () => {
    request.mockRejectedValue(axErr(401));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ status: 401, kind: 'unauthorized', key: 'errors.common.unknownError' });
  });

  it('429 senza chiave errors.* -> rateLimited; errors.vault.locked resta distinguibile', async () => {
    request.mockRejectedValueOnce(axErr(429, 'Too Many Requests'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ kind: 'rateLimited', key: 'errors.vault.rateLimited' });
    request.mockRejectedValueOnce(axErr(429, 'errors.vault.locked'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ kind: 'rateLimited', key: 'errors.vault.locked' });
  });

  it.each([413, 415])('%i senza body -> invalid', async (status) => {
    request.mockRejectedValue(axErr(status));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ kind: 'invalid', key: 'errors.vault.invalidPayload' });
  });

  it('errore di rete -> kind network', async () => {
    request.mockRejectedValue(new Error('boom'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ kind: 'network', status: 0 });
  });

  it('429 su unlock non ritenta', async () => {
    request.mockRejectedValue(axErr(429, 'k'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ kind: 'rateLimited' });
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('retry 429', () => {
  it('getItems ritenta una volta dopo il backoff', async () => {
    vi.useFakeTimers();
    request.mockRejectedValueOnce(axErr(429, 'k')).mockResolvedValueOnce({ data: { items: [] } });
    const p = vaultApi.getItems({});
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toEqual({ items: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('migrateItems: secondo 429 -> errore tipizzato, max 2 chiamate; honora retry-after', async () => {
    vi.useFakeTimers();
    request.mockRejectedValue(axErr(429, 'k', { 'retry-after': '2' }));
    const p = vaultApi.migrateItems([]);
    const assertion = fail(p);
    await vi.advanceTimersByTimeAsync(1999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await assertion).toMatchObject({ kind: 'rateLimited' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retry-after 60 -> attesa cappata a 5000 ms', async () => {
    vi.useFakeTimers();
    request.mockRejectedValueOnce(axErr(429, 'k', { 'retry-after': '60' })).mockResolvedValueOnce({ data: 1 });
    const p = vaultApi.getItems({});
    await vi.advanceTimersByTimeAsync(4999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe(1);
  });

  it('getItems: nessun retry prima del ritardo (1 chiamata a 999 ms)', async () => {
    vi.useFakeTimers();
    request.mockRejectedValue(axErr(429, 'k'));
    const assertion = fail(vaultApi.getItems({}));
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
  });
});

describe('migrateItems', () => {
  it('timeout per richiesta di 120000 ms', async () => {
    request.mockResolvedValue({ data: {} });
    await vaultApi.migrateItems([]);
    expect(request.mock.calls[0][0]).toMatchObject({ url: '/vault/migrate', timeout: 120000 });
  });
});

describe('getKeyring', () => {
  const stubCaches = () => {
    const del = vi.fn();
    const keys = ['https://x/api/vault/keyring', 'https://x/api/notes'].map((url) => ({ url }));
    vi.stubGlobal('caches', { open: async () => ({ keys: async () => keys, delete: del }) });
    return del;
  };

  it('purga solo le voci /vault/, anche in errore', async () => {
    const del = stubCaches();
    request.mockRejectedValue(axErr(503));
    await fail(vaultApi.getKeyring());
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][0].url).toContain('/vault/');
  });

  it('purga anche in successo', async () => {
    const del = stubCaches();
    request.mockResolvedValue({ data: {} });
    await vaultApi.getKeyring();
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe('createKeyring', () => {
  it('invia password e nessun migrationState; nessun Cache-Control', async () => {
    request.mockResolvedValue({ data: {} });
    await vaultApi.createKeyring({ password: 'pw', expectedEpoch: 0 } as never);
    const cfg = request.mock.calls[0][0];
    expect(cfg).toMatchObject({ method: 'post', url: '/vault/keyring' });
    expect(cfg.headers).toBeUndefined();
    expect(cfg.data.password).toBe('pw');
    expect('migrationState' in cfg.data).toBe(false);
  });
});
