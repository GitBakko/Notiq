// Postbuild: la chiave root di test (E2E) non deve MAI finire nel bundle di produzione; quella di produzione deve esserci
// (controllo positivo: senza, una dist vuota o un glob rotto passerebbe in silenzio).
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PROD_ID = 'rk_68a265761e7e37c7';
const TEST_ID = 'rk_42f37978a7909b3e';
const TEST_SPKI = [
  'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEcfIJTVDdJbPPRd4-B2T-cGQ3DqTHR7soIEat06LaQ4WlUuG-N8cWNHocaDihzzuD_oCLS1QeeTbh0zaC7TozMc1axF0j2gwk-2iGYr9cVytb2AracHycVs-r9TDNfLbg',
  'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEA_H3BOwmJhlYyygtRNnYsyq3-7I4EAi_YGEH7f1EzXCAbXYZjN2epM1TGxDI2GUxgzRhqVrRABUtFb-leNtcPPRV2XViW1CQksSpPLy0vjaQvjd2NCzU7vUzxgoDTWcF',
];
const FRAG = 24;
const HEADER = 40; // l'intestazione DER di SPKI secp384r1 e' uguale per tutte le chiavi: la salto per non avere falsi positivi

// Solo i binari (immagini, font) sono saltati: id e SPKI potrebbero finire anche in .map, .html, .json, .webmanifest.
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.webm', '.pdf', '.wasm']);

function allFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? allFiles(p) : BINARY.has(extname(p).toLowerCase()) ? [] : [p];
  });
}

let files;
try { files = allFiles(dist); } catch { files = []; }
if (!files.length) { console.error(`check-bundle-root-keys: nessun file in ${dist} (build mancante?)`); process.exit(1); }

const needles = [TEST_ID];
for (const spki of TEST_SPKI) for (let i = HEADER; i + FRAG <= spki.length; i++) needles.push(spki.slice(i, i + FRAG));

let prodFound = false;
const leaks = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  if (src.includes(PROD_ID)) prodFound = true;
  if (needles.some((n) => src.includes(n))) leaks.push(f);
}

if (leaks.length) {
  // Senza index.html la dist avvelenata non si serve ne' si impacchetta per errore (Build-Package richiede index.html).
  try { rmSync(join(dist, 'index.html'), { force: true }); } catch { /* best effort */ }
  console.error(`check-bundle-root-keys: la chiave root di TEST e' nel bundle di produzione:\n  ${leaks.join('\n  ')}\ndist/index.html eliminato. Il blocco E2E in src/utils/vaultRootKeys.ts deve restare dietro MODE development.`);
  process.exit(1);
}
if (!prodFound) { console.error(`check-bundle-root-keys: l'id di produzione ${PROD_ID} NON e' nel bundle (controllo positivo fallito).`); process.exit(1); }
console.log(`check-bundle-root-keys: ok (${files.length} file, chiave di test assente, chiave di produzione presente)`);
