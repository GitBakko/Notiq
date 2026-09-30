import { describe, it, expect, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { argon2id } from 'hash-wasm';
import {
  generateRootKeyPair,
  sealRootKeyFile,
  openRootKeyFile,
  assertPathOutsideApp,
  writeAtomicNoOverwrite,
} from '../utils/vaultRootKeyFile';

const KDF = { m: 8192, t: 1, p: 1 };
const PASS = 'correct horse battery staple 123';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vrk-test-'));
const tmpFile = (name: string) => path.join(tmpDir, name);

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function sealOne() {
  const kp = generateRootKeyPair();
  const sealed = await sealRootKeyFile({ [kp.rootKeyId]: kp }, PASS, KDF);
  return { kp, sealed };
}

describe('vaultRootKeyFile', () => {
  it('passphrase giusta apre il file, sbagliata lancia con messaggio fisso', async () => {
    const { kp, sealed } = await sealOne();
    const f = tmpFile('ok.json');
    fs.writeFileSync(f, sealed);

    const opened = await openRootKeyFile(f, PASS);
    expect(Object.keys(opened.keys)).toEqual([kp.rootKeyId]);
    expect(opened.keys[kp.rootKeyId].ecdhPkcs8.equals(kp.ecdhPkcs8)).toBe(true);
    expect(opened.keys[kp.rootKeyId].ecdsaSpki.equals(kp.ecdsaSpki)).toBe(true);

    await expect(openRootKeyFile(f, 'wrong passphrase wrong passphrase')).rejects.toThrow(
      'vault root file: cannot open',
    );
    await expect(openRootKeyFile(f, 'wrong passphrase wrong passphrase')).rejects.not.toThrow(/wrong passphrase/);
  });

  it('rootKeyId = rk_ + sha256(ecdhSpki||ecdsaSpki)[0..16]', () => {
    const kp = generateRootKeyPair();
    const h = crypto.createHash('sha256').update(Buffer.concat([kp.ecdhSpki, kp.ecdsaSpki])).digest('hex');
    expect(kp.rootKeyId).toBe('rk_' + h.slice(0, 16));
  });

  it('un byte alterato nell header o in ct lancia', async () => {
    const { sealed } = await sealOne();
    const flip = (s: string, i: number) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

    // header: altero un carattere del valore pub.ecdhSpki (il JSON interno resta valido)
    const obj = JSON.parse(sealed) as { header: string; ct: string };
    const at = obj.header.indexOf('"ecdhSpki":"') + '"ecdhSpki":"'.length + 10;
    const badHeader = JSON.stringify({ header: flip(obj.header, at), ct: obj.ct });
    const f1 = tmpFile('bad-header.json');
    fs.writeFileSync(f1, badHeader);
    await expect(openRootKeyFile(f1, PASS)).rejects.toThrow('vault root file: cannot open');

    // header: altero il salt (AAD cambia e la chiave cambia)
    const at2 = obj.header.indexOf('"iv":"') + '"iv":"'.length + 2;
    const f2 = tmpFile('bad-iv.json');
    fs.writeFileSync(f2, JSON.stringify({ header: flip(obj.header, at2), ct: obj.ct }));
    await expect(openRootKeyFile(f2, PASS)).rejects.toThrow('vault root file: cannot open');

    // ct
    const f3 = tmpFile('bad-ct.json');
    fs.writeFileSync(f3, JSON.stringify({ header: obj.header, ct: flip(obj.ct, 20) }));
    await expect(openRootKeyFile(f3, PASS)).rejects.toThrow('vault root file: cannot open');
  });

  it('il file non contiene i PKCS#8 in chiaro', async () => {
    const { kp, sealed } = await sealOne();
    expect(sealed).not.toContain(kp.ecdhPkcs8.toString('base64url'));
    expect(sealed).not.toContain(kp.ecdsaPkcs8.toString('base64url'));
    expect(sealed).not.toContain(kp.ecdhPkcs8.toString('base64'));
    expect(sealed.toLowerCase()).not.toContain('3081b6020100');
    // nemmeno l'hex del DER
    expect(sealed.toLowerCase()).not.toContain(kp.ecdhPkcs8.toString('hex'));
  });

  it('una mappa con 2 id apre entrambi', async () => {
    const a = generateRootKeyPair();
    const b = generateRootKeyPair();
    const sealed = await sealRootKeyFile({ [a.rootKeyId]: a, [b.rootKeyId]: b }, PASS, KDF);
    const f = tmpFile('two.json');
    fs.writeFileSync(f, sealed);
    const opened = await openRootKeyFile(f, PASS);
    expect(Object.keys(opened.keys).sort()).toEqual([a.rootKeyId, b.rootKeyId].sort());
    expect(opened.keys[b.rootKeyId].ecdhPkcs8.equals(b.ecdhPkcs8)).toBe(true);
  });

  it('le chiavi decifrate funzionano: ECDH e ECDSA', async () => {
    const { kp, sealed } = await sealOne();
    const f = tmpFile('use.json');
    fs.writeFileSync(f, sealed);
    const k = (await openRootKeyFile(f, PASS)).keys[kp.rootKeyId];

    // ECDH con una coppia effimera P-384
    const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const rootPriv = crypto.createPrivateKey({ key: k.ecdhPkcs8, format: 'der', type: 'pkcs8' });
    const rootPub = crypto.createPublicKey({ key: k.ecdhSpki, format: 'der', type: 'spki' });
    const s1 = crypto.diffieHellman({ privateKey: rootPriv, publicKey: eph.publicKey });
    const s2 = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: rootPub });
    expect(s1.equals(s2)).toBe(true);

    // ECDSA
    const sigPriv = crypto.createPrivateKey({ key: k.ecdsaPkcs8, format: 'der', type: 'pkcs8' });
    const sigPub = crypto.createPublicKey({ key: k.ecdsaSpki, format: 'der', type: 'spki' });
    const msg = Buffer.from('msg');
    const sig = crypto.sign('sha384', msg, sigPriv);
    expect(crypto.verify('sha384', msg, sigPub, sig)).toBe(true);
    expect(crypto.verify('sha384', Buffer.from('other'), sigPub, sig)).toBe(false);
  });

  it('assertPathOutsideApp', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    // prova che repoRoot e' davvero la radice del repo (profondita' corretta)
    expect(fs.existsSync(path.join(repoRoot, 'backend', 'package.json'))).toBe(true);
    const inRepo = path.join(repoRoot, 'backend', 'x.json');
    expect(() => assertPathOutsideApp(inRepo)).toThrow('vault root file: path inside app tree');
    expect(() => assertPathOutsideApp(repoRoot)).toThrow('vault root file: path inside app tree');
    expect(() => assertPathOutsideApp(path.join(os.tmpdir(), 'x.json'))).not.toThrow();

    if (process.platform === 'win32') {
      // case-insensitive
      expect(() => assertPathOutsideApp(inRepo.toUpperCase())).toThrow('vault root file: path inside app tree');
      // UNC e prefissi device: rifiutati
      const drive = inRepo[0];
      expect(() => assertPathOutsideApp('\\\\localhost\\' + drive + '$' + inRepo.slice(2))).toThrow(
        'local drive path',
      );
      expect(() => assertPathOutsideApp('\\\\?\\' + inRepo)).toThrow('local drive path');
    }
  });

  it('assertPathOutsideApp segue junction/symlink verso l\'app', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const link = tmpFile('junction-to-repo');
    try {
      fs.symlinkSync(path.join(repoRoot, 'backend'), link, 'junction');
    } catch {
      return; // junction/symlink non creabile qui: test saltato
    }
    expect(() => assertPathOutsideApp(path.join(link, 'x.json'))).toThrow('vault root file: path inside app tree');
    fs.unlinkSync(link); // rimuove il link, non il target
  });

  it('writeAtomicNoOverwrite non sovrascrive e scrive se assente', () => {
    const f = tmpFile('exists.json');
    fs.writeFileSync(f, 'original');
    expect(() => writeAtomicNoOverwrite(f, 'new')).toThrow('vault root file: destination exists');
    expect(fs.readFileSync(f, 'utf8')).toBe('original');
    expect(fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp-'))).toEqual([]);

    const g = tmpFile('fresh.json');
    writeAtomicNoOverwrite(g, 'hello');
    expect(fs.readFileSync(g, 'utf8')).toBe('hello');
    expect(fs.readdirSync(tmpDir).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('assertPathOutsideApp rifiuta un realpath UNC (drive mappato/junction)', () => {
    const spy = vi.spyOn(fs.realpathSync, 'native').mockReturnValue('\\\\localhost\\D$\\x');
    try {
      expect(() => assertPathOutsideApp(path.join(os.tmpdir(), 'x.json'))).toThrow('local drive path');
    } finally {
      spy.mockRestore();
    }
  });

  it('writeAtomicNoOverwrite: linkSync fallisce con EPERM -> messaggio dedicato, nessun tmp residuo', () => {
    const before = fs.readdirSync(tmpDir).length;
    const spy = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw Object.assign(new Error('nope'), { code: 'EPERM' });
    });
    try {
      expect(() => writeAtomicNoOverwrite(tmpFile('nolink.json'), 'x')).toThrow('cannot create the file here');
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(tmpDir).length).toBe(before);
  });

  it('openRootKeyFile rifiuta SPKI di un\'altra coppia, id non coerente, kdfParams fuori limiti', async () => {
    const FIXED = 'vault root file: cannot open';
    const kp = generateRootKeyPair();
    const other = generateRootKeyPair();

    // ecdhSpki di un'altra coppia
    const f1 = tmpFile('spki-other.json');
    fs.writeFileSync(f1, await sealRootKeyFile({ [kp.rootKeyId]: { ...kp, ecdhSpki: other.ecdhSpki } }, PASS, KDF));
    await expect(openRootKeyFile(f1, PASS)).rejects.toThrow(FIXED);

    // chiave della mappa diversa dal rootKeyId derivato
    const f2 = tmpFile('id-mismatch.json');
    fs.writeFileSync(f2, await sealRootKeyFile({ rk_0000000000000000: kp }, PASS, KDF));
    await expect(openRootKeyFile(f2, PASS)).rejects.toThrow(FIXED);

    // kdfParams ostili: errore fisso subito, senza derivare
    const sealed = JSON.parse(await sealRootKeyFile({ [kp.rootKeyId]: kp }, PASS, KDF)) as { header: string; ct: string };
    for (const bad of [{ t: 10000 }, { m: 4194304 }, { m: 4 }, { p: 100 }, { t: 0 }, { t: 1.5 }]) {
      const header = JSON.parse(sealed.header) as { kdfParams: Record<string, number> };
      Object.assign(header.kdfParams, bad);
      const f = tmpFile('kdf-bad.json');
      fs.writeFileSync(f, JSON.stringify({ header: JSON.stringify(header), ct: sealed.ct }));
      const t0 = Date.now();
      await expect(openRootKeyFile(f, PASS)).rejects.toThrow(FIXED);
      expect(Date.now() - t0).toBeLessThan(1000);
    }
  });

  it('la passphrase e\' normalizzata NFC: forma NFC e NFD sono equivalenti', async () => {
    const nfc = 'passwèrd-long-enough-xx';
    const nfd = 'passwèrd-long-enough-xx';
    expect(nfc).not.toBe(nfd);
    const kp = generateRootKeyPair();
    const f = tmpFile('nfc.json');
    fs.writeFileSync(f, await sealRootKeyFile({ [kp.rootKeyId]: kp }, nfc, KDF));
    const opened = await openRootKeyFile(f, nfd);
    expect(Object.keys(opened.keys)).toEqual([kp.rootKeyId]);
  });

  describe('vettore noto Argon2id (da riusare in P2)', () => {
    // Parametri piccoli: password 'password', salt 'somesaltsomesalt', t 2, m 1024, p 1, 32 byte.
    // Valore verificato indipendentemente: hash-wasm 4.12.0 e crypto.argon2Sync di Node 24 danno lo stesso
    // risultato; in piu' argon2Sync riproduce il vettore ufficiale RFC 9106 §5.3 (vedi sotto).
    const EXPECTED = '08a19ee7f6d7f589c2ab6af18d6e724172b19f7d6fd462b38430ab31ceabeaf0';

    it('hash-wasm produce il valore fissato', async () => {
      const out = await argon2id({
        password: 'password',
        salt: 'somesaltsomesalt',
        parallelism: 1,
        iterations: 2,
        memorySize: 1024,
        hashLength: 32,
        outputType: 'binary',
      });
      expect(Buffer.from(out).toString('hex')).toBe(EXPECTED);
    });

    type Argon2Sync = (alg: string, p: Record<string, unknown>) => Buffer;
    const argon2Sync = (crypto as unknown as { argon2Sync?: Argon2Sync }).argon2Sync;

    it.skipIf(!argon2Sync)('il riferimento indipendente (crypto.argon2Sync) coincide', () => {
      const ref = argon2Sync!('argon2id', {
        message: Buffer.from('password'),
        nonce: Buffer.from('somesaltsomesalt'),
        parallelism: 1,
        tagLength: 32,
        memory: 1024,
        passes: 2,
      });
      expect(ref.toString('hex')).toBe(EXPECTED);
    });

    it.skipIf(!argon2Sync)('crypto.argon2Sync riproduce il vettore RFC 9106 §5.3 (argon2id)', () => {
      const ref = argon2Sync!('argon2id', {
        message: Buffer.alloc(32, 0x01),
        nonce: Buffer.alloc(16, 0x02),
        secret: Buffer.alloc(8, 0x03),
        associatedData: Buffer.alloc(12, 0x04),
        parallelism: 4,
        tagLength: 32,
        memory: 32,
        passes: 3,
      });
      expect(ref.toString('hex')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659');
    });
  });
});
