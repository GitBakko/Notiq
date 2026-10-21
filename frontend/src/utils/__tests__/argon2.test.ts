import { describe, it, expect, afterEach, vi } from 'vitest';
import { argon2Raw, deriveS, resetArgon2Worker, DEFAULT_KDF } from '../argon2';

const EXPECTED = '08a19ee7f6d7f589c2ab6af18d6e724172b19f7d6fd462b38430ab31ceabeaf0';
const hex = (u: Uint8Array) => Buffer.from(u).toString('hex');
const KAT = { m: 1024, t: 2, p: 1 };

describe('argon2 fallback diretto (Worker assente)', () => {
  it('KAT identico al backend', async () => {
    expect(hex(await argon2Raw('password', 'somesaltsomesalt', KAT))).toBe(EXPECTED);
  });
  it('NFD dopo NFC = hash della forma NFC', async () => {
    const nfc = 'passwèrd';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(hex(await argon2Raw(nfd, 'somesaltsomesalt', KAT))).toBe(hex(await argon2Raw(nfc, 'somesaltsomesalt', KAT)));
  });
  it.each([
    { m: 32768, t: 3, p: 1 },
    { m: 65536, t: 2, p: 1 },
    { m: 65536, t: 3, p: 2 },
    { m: 2097152, t: 3, p: 1 },
    { m: 65536, t: 11, p: 1 },
  ])('deriveS rifiuta %j', async (params) => {
    await expect(deriveS('k7Rq2x', new Uint8Array(16), params)).rejects.toThrow('kdfFailed');
  });
  it.each([new Uint8Array(15), new Uint8Array(17), 'somesaltsomesalt'])('deriveS rifiuta salt non Uint8Array(16)', async (salt) => {
    await expect(deriveS('k7Rq2x', salt as Uint8Array, DEFAULT_KDF)).rejects.toThrow('kdfFailed');
  });
  it('DEFAULT_KDF', () => expect(DEFAULT_KDF).toEqual({ m: 65536, t: 3, p: 1 }));
});

describe('argon2 con Worker', () => {
  class FakeWorker {
    static instances: FakeWorker[] = [];
    static mode: 'ok' | 'fail' | 'hang' = 'ok';
    terminated = false;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() { FakeWorker.instances.push(this); }
    postMessage(msg: { id: number }) {
      if (FakeWorker.mode === 'hang') return;
      const ok = FakeWorker.mode === 'ok';
      queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, ok, out: ok ? new Uint8Array(32) : undefined } }));
    }
    terminate() { this.terminated = true; }
  }
  const salt = new Uint8Array(16);

  afterEach(() => {
    resetArgon2Worker();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeWorker.instances = [];
    FakeWorker.mode = 'ok';
  });

  it('rifiuto: terminate e Worker nuovo alla chiamata seguente', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.mode = 'fail';
    await expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).rejects.toThrow('kdfFailed');
    expect(FakeWorker.instances[0].terminated).toBe(true);
    FakeWorker.mode = 'ok';
    await expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).resolves.toHaveLength(32);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('timeout 30 s: kdfFailed, terminate, ricreazione', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.mode = 'hang';
    const assertion = expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).rejects.toThrow('kdfFailed');
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(FakeWorker.instances[0].terminated).toBe(true);
    FakeWorker.mode = 'ok';
    await expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).resolves.toHaveLength(32);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('dopo reset la chiamata seguente crea un Worker nuovo', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    await deriveS('k7Rq2x', salt, DEFAULT_KDF);
    resetArgon2Worker();
    expect(FakeWorker.instances[0].terminated).toBe(true);
    await deriveS('k7Rq2x', salt, DEFAULT_KDF);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('deriveS in volo + reset -> rifiuto immediato, la chiamata seguente riesce', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.mode = 'hang';
    const assertion = expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).rejects.toThrow('kdfFailed');
    resetArgon2Worker();
    await assertion;
    FakeWorker.mode = 'ok';
    await expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).resolves.toHaveLength(32);
  });

  it('il timer della vecchia istanza non termina quella nuova', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    FakeWorker.mode = 'hang';
    const a = expect(deriveS('k7Rq2x', salt, DEFAULT_KDF)).rejects.toThrow('kdfFailed');
    // clearTimeout neutralizzato: il timer di A resta vivo dopo il reset.
    const spy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {});
    resetArgon2Worker();
    await a;
    spy.mockRestore();
    FakeWorker.mode = 'ok';
    await deriveS('k7Rq2x', salt, DEFAULT_KDF);
    expect(FakeWorker.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000); // scade il timer di A
    expect(FakeWorker.instances[1].terminated).toBe(false);
  });
});

describe('argon2.worker: contratto dei messaggi', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  async function load() {
    const fakeSelf = { postMessage: vi.fn(), onmessage: null as null | ((e: { data: unknown }) => Promise<void>) };
    vi.stubGlobal('self', fakeSelf);
    vi.resetModules();
    await import('../argon2.worker');
    return fakeSelf;
  }

  it('risposta {id, ok:true, out} uguale al KAT', async () => {
    const s = await load();
    await s.onmessage!({ data: { id: 1, pin: 'password', salt: 'somesaltsomesalt', m: 1024, t: 2, p: 1 } });
    const msg = s.postMessage.mock.calls[0][0];
    expect(msg.id).toBe(1);
    expect(msg.ok).toBe(true);
    expect(hex(msg.out)).toBe(EXPECTED);
  });

  it('parametri non validi -> {id, ok:false}', async () => {
    const s = await load();
    await s.onmessage!({ data: { id: 2, pin: 'password', salt: 'x', m: 1024, t: 2, p: 1 } }); // salt < 8 B
    expect(s.postMessage).toHaveBeenCalledWith({ id: 2, ok: false });
  });
});
