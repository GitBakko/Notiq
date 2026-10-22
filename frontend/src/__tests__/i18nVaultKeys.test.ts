// @vitest-environment node
// Copertura i18n del vault (piano P2, T24): ogni chiave letterale vault.*, errors.vault.*, errors.common.* usata nei sorgenti,
// piu' le famiglie dinamiche e le chiavi di errore del backend, deve esistere in en.json E it.json.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readLocale = (l: string) => JSON.parse(fs.readFileSync(path.join(SRC, 'locales', `${l}.json`), 'utf8')) as Record<string, unknown>;
const LOCALES = { en: readLocale('en'), it: readLocale('it') };

const lookup = (o: Record<string, unknown>, key: string): unknown =>
  key.split('.').reduce<unknown>((c, p) => (c && typeof c === 'object' ? (c as Record<string, unknown>)[p] : undefined), o);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'locales' || e.name === 'node_modules') continue;
      sourceFiles(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

// Chiavi letterali: una stringa intera 'vault.x.y' / "errors.vault.x" / `errors.common.x`. I prefissi dinamici (`vault.move.${code}`,
// 'vault.kit.errors.') non combaciano (manca la foglia prima della virgoletta) e sono coperti dalle liste esplicite qui sotto.
const KEY_RE = /['"`]((?:errors\.vault|errors\.common|vault)(?:\.[A-Za-z0-9_]+)+)['"`]/g;

const usedKeys = (() => {
  const keys = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(KEY_RE)) keys.add(m[1]);
  }
  return [...keys].sort();
})();

const expectBoth = (keys: string[]) => {
  const missing: string[] = [];
  for (const k of keys) for (const [l, o] of Object.entries(LOCALES)) {
    const v = lookup(o, k);
    if (typeof v !== 'string' || v.trim() === '') missing.push(`${l}:${k}`);
  }
  expect(missing).toEqual([]);
};

const family = (prefix: string, leaves: string[]) => leaves.map((l) => `${prefix}.${l}`);

// Famiglie costruite con template (`t(\`vault.xxx.${code}\`)`): elenco dei valori possibili.
const MOVE_CODES = ['offline', 'conflict', 'notReady', 'failed', 'locked', 'pending', 'failedQueued']; // VaultMoveCode senza attachmentsBlocked per moveIn
const DYNAMIC = [
  ...family('vault.moveIn', MOVE_CODES), // NoteEditor: attachmentsBlocked va su errors.vault.attachmentsBlocked
  ...family('vault.moveOut', [...MOVE_CODES, 'attachmentsBlocked']), // VaultNoteEditor: t(`vault.moveOut.${code}`)
  ...family('vault.migrate.errors', ['flushTimeout', 'locked', 'invalid', 'aborted', 'busy', 'notReady']), // MigrationErrorCode
  ...family('vault.migrate.step', ['flush', 'setup', 'migrate', 'close']),
  ...family('vault.pinPolicy', ['format', 'date', 'sequence', 'repetition', 'common', 'personal']), // PinRejection
  ...family('vault.kit.errors', ['invalidLength', 'invalidChar', 'checksum', 'pdfOverflow']),
  ...family('vault.settings.how', ['pin', 'kit', 'offline', 'device']),
  ...family('vault.settings.reason', ['legacyPin', 'epoch', 'tooLarge', 'unchanged']),
  ...family('vault.settings.skipped', ['locked', 'notReady', 'busy']), // ReconcileResult.skipped
  ...family('vault.credential.generator', ['uppercase', 'lowercase', 'digits', 'symbols']),
];

// Chiavi di errore restituite dal backend (AppError / reply.code) e dal client (vaultApi, vaultSession) che arrivano alla UI.
const BACKEND_ERRORS = [
  ...family('errors.vault', [
    'alreadySetup', 'attachmentsBlocked', 'conflict', 'importBlocked', 'invalidPassword', 'invalidPayload', 'invalidPin', 'invalidProof',
    'invalidRootKey', 'invalidSeal', 'invalidSealInput', 'locked', 'notReady', 'pepperMismatch', 'plaintextRejected', 'plaintextRequired',
    'rotateNotSupported', 'setupDisabled', 'stale', 'staleRev', 'unavailable',
  ]),
  ...family('errors.vault', ['rateLimited', 'offlineUnavailable', 'kitNotUpdated']), // generate lato client
  ...family('errors.common', ['networkError', 'unknownError']),
  'errors.notes.restoreConflict',
  'errors.notes.restoreUnsupportedLive',
];

describe('i18n del vault', () => {
  it('trova le chiavi letterali nei sorgenti (controllo positivo dello scanner)', () => {
    expect(usedKeys.length).toBeGreaterThan(100);
    expect(usedKeys).toEqual(expect.arrayContaining(['errors.vault.invalidPayload', 'vault.kit.title', 'errors.common.unknownError']));
  });

  it('ogni chiave letterale usata nei sorgenti esiste in en.json e it.json', () => expectBoth(usedKeys));
  it('le famiglie dinamiche (template) esistono in en.json e it.json', () => expectBoth(DYNAMIC));
  it('gli errori del backend vault e di vaultApi/vaultSession esistono in en.json e it.json', () => expectBoth(BACKEND_ERRORS));

  it('ogni chiave errors.vault.* usata nel backend esiste in en.json e it.json', () => {
    const root = path.resolve(SRC, '../../backend/src');
    const keys = new Set<string>();
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p); }
        else if (/.ts$/.test(e.name) && !/.(test|spec)./.test(e.name)) {
          for (const m of fs.readFileSync(p, 'utf8').matchAll(KEY_RE)) if (m[1].startsWith('errors.vault.')) keys.add(m[1]);
        }
      }
    };
    walk(root);
    expect(keys.size).toBeGreaterThan(0);
    expectBoth([...keys].sort());
  });

  it('en e it hanno gli stessi segnaposto {{...}}', () => {
    const bad: string[] = [];
    const ph = (s: unknown) => (typeof s === 'string' ? (s.match(/\{\{\s*\w+\s*\}\}/g) ?? []).sort().join('|') : '');
    for (const k of new Set([...usedKeys, ...DYNAMIC, ...BACKEND_ERRORS])) {
      if (ph(lookup(LOCALES.en, k)) !== ph(lookup(LOCALES.it, k))) bad.push(k);
    }
    expect(bad).toEqual([]);
  });
});
