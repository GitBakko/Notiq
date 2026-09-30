import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  generateRootKeyPair,
  sealRootKeyFile,
  openRootKeyFile,
  assertPathOutsideApp,
  writeAtomicNoOverwrite,
  RootKeyEntry,
} from '../utils/vaultRootKeyFile';

const USAGE = 'Uso: vault:root-keygen --out <path> | --verify <path>';
const MIN_PASSPHRASE = 20;

// Legge una riga senza eco. Enter conferma, Backspace cancella, Ctrl-C esce con 130.
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buf = '';
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string) => {
      if (chunk.startsWith('\u001b')) return; // sequenze ESC (frecce, F-key, ...): ignorate per intero
      for (const ch of chunk) {
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(buf);
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          buf = Array.from(buf).slice(0, -1).join(''); // un intero code point
        } else if (ch >= ' ') {
          buf += ch; // scarta i caratteri di controllo (Ctrl-D, Ctrl-Z, ...)
        }
      }
    };
    stdin.on('data', onData);
  });
}

function proveKeys(k: RootKeyEntry): void {
  const priv = crypto.createPrivateKey({ key: k.ecdhPkcs8, format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: k.ecdhSpki, format: 'der', type: 'spki' });
  const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const s1 = crypto.diffieHellman({ privateKey: priv, publicKey: eph.publicKey });
  const s2 = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub });
  const okEcdh = s1.equals(s2);
  s1.fill(0);
  s2.fill(0);
  if (!okEcdh) throw new Error('prova ECDH fallita');

  const sigPriv = crypto.createPrivateKey({ key: k.ecdsaPkcs8, format: 'der', type: 'pkcs8' });
  const sigPub = crypto.createPublicKey({ key: k.ecdsaSpki, format: 'der', type: 'spki' });
  const msg = crypto.randomBytes(32);
  if (!crypto.verify('sha384', msg, sigPub, crypto.sign('sha384', msg, sigPriv))) {
    throw new Error('prova ECDSA fallita');
  }
}

function zero(keys: Record<string, RootKeyEntry>): void {
  for (const k of Object.values(keys)) {
    k.ecdhPkcs8.fill(0);
    k.ecdsaPkcs8.fill(0);
  }
}

async function openAndProve(file: string, passphrase: string): Promise<void> {
  const { header, keys } = await openRootKeyFile(file, passphrase);
  try {
    for (const k of Object.values(keys)) proveKeys(k);
    const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    console.log('Verifica OK (decifratura, ECDH, ECDSA).');
    console.log('rootKeyId: ' + Object.keys(keys).join(', '));
    console.log('sha256 del file: ' + sha);
    console.log('pub (da conservare):');
    console.log(JSON.stringify(header.pub, null, 2));
  } finally {
    zero(keys);
  }
}

async function doOut(out: string): Promise<void> {
  assertPathOutsideApp(out);
  if (fs.existsSync(out)) throw new Error('il file di destinazione esiste gia\': non viene sovrascritto');
  if (!fs.existsSync(path.dirname(path.resolve(out)))) throw new Error('la cartella di destinazione non esiste');
  const p1 = await promptHidden('Passphrase (min ' + MIN_PASSPHRASE + ' caratteri): ');
  if (Array.from(p1).length < MIN_PASSPHRASE) throw new Error('passphrase troppo corta (minimo ' + MIN_PASSPHRASE + ' caratteri)');
  const p2 = await promptHidden('Ripeti la passphrase: ');
  if (p1 !== p2) throw new Error('le passphrase non coincidono');

  const kp = generateRootKeyPair();
  try {
    const sealed = await sealRootKeyFile({ [kp.rootKeyId]: kp }, p1);
    writeAtomicNoOverwrite(out, sealed);
    console.log('File scritto: ' + out);
    try {
      await openAndProve(out, p1);
    } catch {
      console.error('ATTENZIONE: la verifica del file scritto e\' FALLITA. Il file NON e\' stato cancellato: non usarlo, ispezionalo.');
      process.exitCode = 1;
    }
  } finally {
    kp.ecdhPkcs8.fill(0);
    kp.ecdsaPkcs8.fill(0);
  }
}

async function doVerify(file: string): Promise<void> {
  const p = await promptHidden('Passphrase: ');
  await openAndProve(file, p);
}

async function main(): Promise<void> {
  const [flag, target, ...rest] = process.argv.slice(2);
  if ((flag !== '--out' && flag !== '--verify') || !target || rest.length > 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    console.error('Errore: richiede una console interattiva (TTY).');
    process.exitCode = 1;
    return;
  }
  try {
    if (flag === '--out') await doOut(target);
    else await doVerify(target);
  } catch (e) {
    console.error('Errore: ' + (e instanceof Error ? e.message : 'sconosciuto'));
    process.exitCode = 1;
  }
}

void main();
