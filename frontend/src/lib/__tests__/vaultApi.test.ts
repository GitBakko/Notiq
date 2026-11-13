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

  it('fromServer: vero solo se il body ha un message errors.*; un 503 di proxy (senza body o HTML) no', async () => {
    request.mockRejectedValueOnce(axErr(503, 'errors.vault.pepperMismatch'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ status: 503, fromServer: true });
    request.mockRejectedValueOnce(axErr(503));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ status: 503, fromServer: false });
    request.mockRejectedValueOnce(axErr(503, '<html>Service Unavailable</html>'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ status: 503, fromServer: false });
    request.mockRejectedValueOnce(new AxiosError('boom'));
    expect(await fail(vaultApi.unlock('a'))).toMatchObject({ status: 0, fromServer: false });
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

const KEYRING_OK = { status: 'READY', epoch: 0, rev: 3 };

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
    request.mockResolvedValue({ data: KEYRING_OK });
    await vaultApi.getKeyring();
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe('createKeyring', () => {
  it('invia password e nessun migrationState; nessun Cache-Control', async () => {
    request.mockResolvedValue({ data: { status: 'READY', epoch: 0, rev: 1 } });
    await vaultApi.createKeyring({ password: 'pw', expectedEpoch: 0 } as never);
    const cfg = request.mock.calls[0][0];
    expect(cfg).toMatchObject({ method: 'post', url: '/vault/keyring' });
    expect(cfg.headers).toBeUndefined();
    expect(cfg.data.password).toBe('pw');
    expect('migrationState' in cfg.data).toBe(false);
  });
});

describe('recovery', () => {
  const ID = '0b6f1c2e-1111-4222-8333-444455556666';

  it('createRecovery: POST /vault/recovery con clientEphPub (e reason solo se data)', async () => {
    request.mockResolvedValue({ data: { id: ID, fingerprint: 'AAAAAAAA' } });
    await expect(vaultApi.createRecovery('pub')).resolves.toEqual({ id: ID, fingerprint: 'AAAAAAAA' });
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'post', url: '/vault/recovery', data: { clientEphPub: 'pub' } });
    expect('reason' in request.mock.calls[0][0].data).toBe(false);
    await vaultApi.createRecovery('pub', 'motivo');
    expect(request.mock.calls[1][0].data).toEqual({ clientEphPub: 'pub', reason: 'motivo' });
  });

  it('getRecovery: GET /vault/recovery/:id e purga la cache /vault/ anche in errore', async () => {
    const del = vi.fn();
    vi.stubGlobal('caches', { open: async () => ({ keys: async () => [{ url: `https://x/api/vault/recovery/${ID}` }, { url: 'https://x/api/notes' }], delete: del }) });
    request.mockResolvedValueOnce({ data: { status: 'RELEASED' } });
    await expect(vaultApi.getRecovery(ID)).resolves.toEqual({ status: 'RELEASED' });
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'get', url: `/vault/recovery/${ID}` });
    expect(del).toHaveBeenCalledTimes(1);
    request.mockRejectedValueOnce(axErr(404, 'errors.vault.recoveryNotFound'));
    expect(await fail(vaultApi.getRecovery(ID))).toMatchObject({ status: 404, key: 'errors.vault.recoveryNotFound' });
    expect(del).toHaveBeenCalledTimes(2);
  });

  it('confirmRecovery: POST /vault/recovery/:id/confirm con i due codici', async () => {
    request.mockResolvedValue({ data: { status: 'WAITING' } });
    await vaultApi.confirmRecovery(ID, 'K7M2Q9XA', 'B7M2Q9XA');
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'post', url: `/vault/recovery/${ID}/confirm`, data: { codeA: 'K7M2Q9XA', codeB: 'B7M2Q9XA' } });
  });

  it('completeRecovery: POST /vault/recovery/:id/complete con payload e vkProof; 409 tipizzato', async () => {
    request.mockResolvedValueOnce({ data: { status: 'COMPLETED' } });
    await vaultApi.completeRecovery(ID, '{"rev":1}', 'proof');
    expect(request.mock.calls[0][0]).toMatchObject({ method: 'post', url: `/vault/recovery/${ID}/complete`, data: { payload: '{"rev":1}', vkProof: 'proof' } });
    request.mockRejectedValueOnce(axErr(409, 'errors.vault.recoveryStateConflict'));
    expect(await fail(vaultApi.completeRecovery(ID, '{}', 'p'))).toMatchObject({ status: 409, kind: 'conflict', key: 'errors.vault.recoveryStateConflict' });
    expect(request).toHaveBeenCalledTimes(2); // nessun retry
  });

  it('id con caratteri speciali codificato nell URL', async () => {
    request.mockResolvedValue({ data: {} });
    await vaultApi.confirmRecovery('a/b', 'x', 'y');
    expect(request.mock.calls[0][0].url).toBe('/vault/recovery/a%2Fb/confirm');
  });
});

// Un intermediario (proxy, portale, pagina d'errore IIS con 200) puo' rispondere 2xx con un body che non e' del vault: i campi mancanti
// non devono diventare fatti positivi. La forma sbagliata e' un errore di rete (esito ambiguo), mai un rifiuto ne' un successo.
describe('forma delle risposte 2xx', () => {
  const NET = { status: 0, kind: 'network', key: 'errors.common.networkError', fromServer: false };
  const GARBAGE = ['<html>portal</html>', '', null, undefined, 42, [], {}, { message: 'ok' }];

  const cases: [string, () => Promise<unknown>, unknown[], unknown][] = [
    ['getKeyring', () => vaultApi.getKeyring(), [{ status: 'x', epoch: 0, rev: 0 }, { status: 'READY', epoch: -1, rev: 0 }, { status: 'READY', epoch: 0, rev: 1.5 }, { status: 'READY', epoch: '0', rev: 0 }, { status: 'READY', epoch: 0 }, { epoch: 0, rev: 0 }], KEYRING_OK],
    ['getRecovery', () => vaultApi.getRecovery('r1'), [{ status: 'DONE' }, { id: 'r1' }], { status: 'COMPLETED' }],
    ['completeRecovery', () => vaultApi.completeRecovery('r1', '{}', 'p'), [{ status: 'WAITING' }, { status: 'completed' }], { status: 'COMPLETED' }],
    ['updateKeyring', () => vaultApi.updateKeyring('{}', 'p'), [{ rev: '4' }, { rev: 1.5 }, { rev: -1 }, { status: 'READY' }], { rev: 4 }],
    ['createKeyring', () => vaultApi.createKeyring({} as never), [{ rev: '1' }, { epoch: 0 }], { status: 'READY', epoch: 0, rev: 1 }],
    ['createRecovery', () => vaultApi.createRecovery('pub'), [{ id: '', fingerprint: 'AAAA' }, { id: 7, fingerprint: 'AAAA' }, { id: 'r1' }, { id: 'r1', fingerprint: null }], { id: 'r1', fingerprint: 'AAAA' }],
  ];

  describe.each(cases)('%s', (_n, fn, bad, good) => {
    it.each(GARBAGE)('body non del vault (%j) -> errore di rete', async (body) => {
      request.mockResolvedValue({ data: body });
      expect(await fail(fn())).toMatchObject(NET);
    });
    it('campi di forma o valore sbagliato -> errore di rete', async () => {
      for (const body of bad) {
        request.mockResolvedValue({ data: body });
        expect(await fail(fn())).toMatchObject(NET);
      }
    });
    it('forma corretta (anche con campi in piu) passa invariata', async () => {
      request.mockResolvedValue({ data: { ...(good as object), extra: 1 } });
      await expect(fn()).resolves.toMatchObject(good as object);
    });
  });

  it('la forma sbagliata non e un rifiuto: fromServer false, status 0 (un 503 vero resta distinguibile)', async () => {
    request.mockResolvedValueOnce({ data: '<html>' });
    expect(await fail(vaultApi.updateKeyring('{}', 'p'))).toMatchObject({ status: 0, fromServer: false });
    request.mockRejectedValueOnce(axErr(503, 'errors.vault.pepperMismatch'));
    expect(await fail(vaultApi.updateKeyring('{}', 'p'))).toMatchObject({ status: 503, fromServer: true });
  });

  it('getKeyring con forma sbagliata purga comunque la cache /vault/', async () => {
    const del = vi.fn();
    vi.stubGlobal('caches', { open: async () => ({ keys: async () => [{ url: 'https://x/api/vault/keyring' }], delete: del }) });
    request.mockResolvedValue({ data: '<html>' });
    await fail(vaultApi.getKeyring());
    expect(del).toHaveBeenCalledTimes(1);
  });
});
