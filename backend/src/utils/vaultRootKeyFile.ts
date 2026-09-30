import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { argon2id } from 'hash-wasm';

export interface KdfParams {
  m: number;
  t: number;
  p: number;
}

export interface RootKeyPublic {
  ecdhSpki: Buffer;
  ecdsaSpki: Buffer;
}

export interface RootKeyEntry extends RootKeyPublic {
  ecdhPkcs8: Buffer;
  ecdsaPkcs8: Buffer;
}

export interface RootKeyPair extends RootKeyEntry {
  rootKeyId: string;
}

export interface RootKeyFileHeader {
  v: number;
  kdf: string;
  kdfParams: KdfParams;
  salt: string;
  iv: string;
  pub: Record<string, { ecdhSpki: string; ecdsaSpki: string }>;
}

const DEFAULT_KDF: KdfParams = { m: 262144, t: 3, p: 1 };
const OPEN_ERROR = 'vault root file: cannot open';

const b64u = (b: Buffer): string => b.toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export function generateRootKeyPair(): RootKeyPair {
  const ecdh = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const ecdsa = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const ecdhSpki = ecdh.publicKey.export({ type: 'spki', format: 'der' });
  const ecdsaSpki = ecdsa.publicKey.export({ type: 'spki', format: 'der' });
  const ecdhPkcs8 = ecdh.privateKey.export({ type: 'pkcs8', format: 'der' });
  const ecdsaPkcs8 = ecdsa.privateKey.export({ type: 'pkcs8', format: 'der' });
  const rootKeyId = rootKeyIdOf(ecdhSpki, ecdsaSpki);
  return { rootKeyId, ecdhSpki, ecdsaSpki, ecdhPkcs8, ecdsaPkcs8 };
}

// La passphrase e' normalizzata NFC prima dell'hash. I client P2 (browser) DEVONO fare lo stesso
// (passphrase.normalize('NFC')), altrimenti la stessa frase digitata su tastiere/OS diversi deriva chiavi diverse.
async function deriveKey(passphrase: string, salt: Buffer, k: KdfParams): Promise<Buffer> {
  const out = await argon2id({
    password: passphrase.normalize('NFC'),
    salt,
    parallelism: k.p,
    iterations: k.t,
    memorySize: k.m,
    hashLength: 32,
    outputType: 'binary',
  });
  const key = Buffer.from(out); // copia
  out.fill(0);
  return key;
}

const isInt = (n: unknown, min: number, max: number): boolean =>
  typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;

// Limiti sui parametri letti dal file: un header ostile non deve poter chiedere GB di RAM o ore di CPU.
function validateKdfParams(k: KdfParams | undefined): void {
  if (!k || !isInt(k.m, 8, 2097152) || !isInt(k.t, 1, 16) || !isInt(k.p, 1, 8)) throw new Error('kdfParams');
}

const rootKeyIdOf = (ecdhSpki: Buffer, ecdsaSpki: Buffer): string =>
  'rk_' + crypto.createHash('sha256').update(Buffer.concat([ecdhSpki, ecdsaSpki])).digest('hex').slice(0, 16);

export async function sealRootKeyFile(
  keys: Record<string, RootKeyEntry>,
  passphrase: string,
  kdfParams: KdfParams = DEFAULT_KDF,
): Promise<string> {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const pub: RootKeyFileHeader['pub'] = {};
  const priv: Record<string, { ecdhPkcs8: string; ecdsaPkcs8: string }> = {};
  for (const [id, k] of Object.entries(keys)) {
    pub[id] = { ecdhSpki: b64u(k.ecdhSpki), ecdsaSpki: b64u(k.ecdsaSpki) };
    priv[id] = { ecdhPkcs8: b64u(k.ecdhPkcs8), ecdsaPkcs8: b64u(k.ecdsaPkcs8) };
  }
  const header = JSON.stringify({ v: 1, kdf: 'argon2id', kdfParams, salt: b64u(salt), iv: b64u(iv), pub });
  const key = await deriveKey(passphrase, salt, kdfParams);
  try {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(header, 'utf8'));
    const ct = Buffer.concat([cipher.update(JSON.stringify(priv), 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ header, ct: b64u(ct) });
  } finally {
    key.fill(0);
  }
}

export async function openRootKeyFile(
  filePath: string,
  passphrase: string,
): Promise<{ header: RootKeyFileHeader; keys: Record<string, RootKeyEntry> }> {
  let key: Buffer | undefined;
  try {
    const file = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { header: string; ct: string };
    if (typeof file.header !== 'string' || typeof file.ct !== 'string') throw new Error('shape');
    const header = JSON.parse(file.header) as RootKeyFileHeader;
    if (header.v !== 1 || header.kdf !== 'argon2id') throw new Error('version');
    validateKdfParams(header.kdfParams);
    key = await deriveKey(passphrase, unb64u(header.salt), header.kdfParams);
    const ct = unb64u(file.ct);
    if (ct.length < 16) throw new Error('short');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64u(header.iv));
    decipher.setAAD(Buffer.from(file.header, 'utf8'));
    decipher.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
    const priv = JSON.parse(plain.toString('utf8')) as Record<string, { ecdhPkcs8: string; ecdsaPkcs8: string }>;
    plain.fill(0);

    const pubIds = Object.keys(header.pub).sort();
    const privIds = Object.keys(priv).sort();
    if (pubIds.length !== privIds.length || pubIds.some((id, i) => id !== privIds[i])) throw new Error('ids');

    const keys: Record<string, RootKeyEntry> = {};
    for (const id of pubIds) {
      const entry: RootKeyEntry = {
        ecdhSpki: unb64u(header.pub[id].ecdhSpki),
        ecdsaSpki: unb64u(header.pub[id].ecdsaSpki),
        ecdhPkcs8: unb64u(priv[id].ecdhPkcs8),
        ecdsaPkcs8: unb64u(priv[id].ecdsaPkcs8),
      };
      // le SPKI pubbliche devono coincidere byte per byte con quelle derivate dalle private decifrate
      const ecdhSpki = crypto.createPublicKey(crypto.createPrivateKey({ key: entry.ecdhPkcs8, format: 'der', type: 'pkcs8' }))
        .export({ type: 'spki', format: 'der' });
      const ecdsaSpki = crypto.createPublicKey(crypto.createPrivateKey({ key: entry.ecdsaPkcs8, format: 'der', type: 'pkcs8' }))
        .export({ type: 'spki', format: 'der' });
      if (!ecdhSpki.equals(entry.ecdhSpki) || !ecdsaSpki.equals(entry.ecdsaSpki)) throw new Error('spki');
      if (rootKeyIdOf(ecdhSpki, ecdsaSpki) !== id) throw new Error('rootKeyId');
      keys[id] = entry;
    }
    return { header, keys };
  } catch {
    // messaggio fisso: niente dettagli, niente passphrase
    throw new Error(OPEN_ERROR);
  } finally {
    key?.fill(0);
  }
}

// Path reale del piu' profondo antenato esistente + coda non ancora esistente (segue symlink/junction).
function realpathWithTail(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const norm = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(norm(root), norm(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}

export function assertPathOutsideApp(p: string): void {
  const resolved = path.resolve(p);
  if (process.platform === 'win32' && !/^[A-Za-z]:\\/.test(resolved)) {
    throw new Error('vault root file: path must be a local drive path like X:\\...');
  }
  const root = path.resolve(__dirname, '../../..');
  const realRoot = fs.realpathSync.native(root);
  const realTarget = realpathWithTail(resolved);
  // drive mappato o junction che risolve in \\server\share: non e' un disco locale
  if (process.platform === 'win32' && !(/^[A-Za-z]:\\/.test(realTarget) && /^[A-Za-z]:\\/.test(realRoot))) {
    throw new Error('vault root file: path must be a local drive path like X:\\...');
  }
  if (isInside(root, resolved) || isInside(realRoot, realTarget)) {
    throw new Error('vault root file: path inside app tree');
  }
}

export function writeAtomicNoOverwrite(p: string, data: string): void {
  const tmp = p + '.tmp-' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.linkSync(tmp, p); // atomico: EEXIST se p esiste gia'
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('vault root file: destination exists');
      throw new Error(
        'vault root file: cannot create the file here (filesystem without hard-link support? use an NTFS volume)',
      );
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best effort */
    }
  }
}
