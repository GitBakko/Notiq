// Vault v3, recupero con la chiave root (Fase 3, T5-T6): sessione client. Nessuna UI.
// Contratti: docs/superpowers/plans/2026-11-12-vault-p4-fase3-plan.md §2 T5-T6, §4; modello della cerimonia: §10 («commit, poi Kit»).
// I byte grezzi (S_root, VK, S, serverShare, Kit vecchio e nuovo) vivono solo dentro le funzioni e si azzerano con fill(0).
// Il nuovo Kit lo restituisce completeRecovery SOLO dopo il 200 del server; il payload non si persiste mai (in IDB resta solo il marker `kit`, uno per escrow: §10.3).
import * as vaultApi from './vaultApi';
import type { RecoveryDto, VaultApiError } from './vaultApi';
import { purgeApiCache } from './apiCache';
import * as device from './deviceKeyStore';
import { cacheKeyring, saveDeviceShare, VaultSessionError, type KeyringDto } from './vaultSession';
import { useVaultStore, type VaultKeys } from '../store/vaultStore';
import { useAuthStore } from '../store/authStore';
import { DEFAULT_KDF, deriveS } from '../utils/argon2';
import {
  b64uDecode, b64uEncode, deriveKekPin, deriveRk, importVk, sha256hexBytes, signVkProof, unwrapEscrow, unwrapVkPin, unwrapVkSigKey,
} from '../utils/vaultCrypto';
import { buildRecoveryPayload, fingerprintOf, generateRecoveryKeyPair, openRecoveryShare, openSealedCodeA, verifyRelease } from '../utils/vaultRecoveryCrypto';
import { getActiveRootKey, VAULT_ROOT_KEYS } from '../utils/vaultRootKeys';
import { parseKit } from '../utils/vaultKit';

export type VaultRecoveryCode =
  | 'releaseInvalid' | 'kitInvalid' | 'notThisDevice' | 'keyringChanged' | 'busy' | 'alreadyOpen' | 'retryLater'
  | 'requestClosed' | 'rejected' | 'completedElsewhere' | 'appliedWithoutKit' | 'appliedKitReplaced' | 'completedUnverified' | 'notReleased' | 'unknown';

/** `key` e' una chiave i18n: `vault.recovery.errors.<code>`, tranne alreadyOpen che riusa `errors.vault.recoveryAlreadyOpen`. */
const errorKey = (code: VaultRecoveryCode) => (code === 'alreadyOpen' ? 'errors.vault.recoveryAlreadyOpen' : `vault.recovery.errors.${code}`);

export class VaultRecoveryError extends Error {
  code: VaultRecoveryCode;
  key: string;
  constructor(code: VaultRecoveryCode) {
    super(errorKey(code));
    this.name = 'VaultRecoveryError';
    this.code = code;
    this.key = errorKey(code);
  }
}

/** Ritardi tra i tentativi della POST del complete (3 tentativi in tutto). */
export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000];
/** Una chiave senza requestId piu' giovane di cosi' puo' avere una POST ancora in volo (3 tentativi da 30 s al massimo, ~94 s). */
const ORPHAN_GRACE_MS = 10 * 60_000;

const rerr = (c: VaultRecoveryCode) => new VaultRecoveryError(c);
const store = () => useVaultStore.getState();
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const zero = (...bufs: (Uint8Array | null | undefined)[]) => { for (const b of bufs) b?.fill(0); };
const isApiError = (e: unknown): e is VaultApiError => !!e && typeof e === 'object' && (e as VaultApiError).name === 'VaultApiError';
const isNotFound = (e: unknown) => isApiError(e) && e.status === 404 && e.key === 'errors.vault.recoveryNotFound';
/** 503 del VAULT (body errors.*): rifiuto certo. Un 503 senza (IIS/ARR, proxy) non dice se la richiesta sia arrivata: e' ambiguo come ogni altro 5xx. */
const isVault503 = (e: VaultApiError) => e.status === 503 && e.fromServer === true;
/** Errore di rete (status 0), 5xx o 429: la POST puo' non essere arrivata o essere stata applicata, si ritenta lo stesso body. Un 503 del vault no: e' un rifiuto esplicito (classify). */
const isTransient = (e: unknown) => !isApiError(e) || e.status === 0 || (e.status >= 500 && !isVault503(e)) || e.status === 429;
/** 4xx tranne 401, piu' il 503 del vault (vale anche 429): il server ha risposto che la richiesta NON e' stata creata. Ambigui: rete, altri 5xx (anche un 503 di proxy), 401. */
const isDefiniteReject = (e: unknown) => isApiError(e) && ((e.status >= 400 && e.status < 500 && e.status !== 401) || isVault503(e));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const fetchKeyring = () => vaultApi.getKeyring<KeyringDto>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Il token e' ancora dell'utente della cerimonia: va controllato prima di ogni scrittura e dopo ogni risposta. */
const isCurrent = (userId: string) => useAuthStore.getState().user?.id === userId;
const notReady = () => new VaultSessionError('notReady', 'errors.vault.notReady');

async function or<T>(code: VaultRecoveryCode, fn: () => Promise<T> | T): Promise<T> {
  try { return await fn(); } catch { throw rerr(code); }
}

/** Passo dopo il commit del server: ogni errore si cattura e si logga (solo il nome, mai segreti). */
async function step(name: string, fn: () => unknown): Promise<void> {
  try { await fn(); } catch (e) { console.warn('[vaultRecovery] passo dopo il commit non riuscito:', name, (e as Error)?.name); }
}

/**
 * Web Lock `notiq-vault-recovery:<userId>` (exclusive, ifAvailable) tenuto SOLO per la durata di `fn`, rilasciato anche dopo un'eccezione. Occupato: busy.
 * Serve solo alla UX (non far partire due cerimonie nella stessa app): la correttezza la danno il CAS del server e il marker `kit` per escrow, quindi senza locks si procede.
 */
async function withLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;
  if (!locks) return fn();
  return locks.request(`notiq-vault-recovery:${userId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) throw rerr('busy');
    return fn();
  });
}

// ---------------------------------------------------------------- T5: richiesta, codice A, pulizia

/**
 * Sync, chiave locale (create-only), POST, poi lega (CAS). Nessun lock: ogni scrittura e' compare-and-set e l'utente del token si controlla prima di scrivere.
 * Chiave gia' legata a una richiesta aperta: recoveryAlreadyOpen; orfana non ancora risolvibile (in grazia, rete): retryLater. Rifiuto 4xx (tranne 401), 429 o 503: chiave cancellata; rete, altri 5xx, 401: resta.
 */
export async function startRecovery(userId: string, reason?: string): Promise<{ id: string; fingerprint: string }> {
  if (!isCurrent(userId)) throw notReady();
  const local = await syncLocalRecovery(userId);
  if (local === 'active') throw rerr('alreadyOpen');
  if (local === 'unknown') throw rerr('retryLater');
  const kp = await generateRecoveryKeyPair();
  const own = await fingerprintOf(kp.publicRaw);
  if (!isCurrent(userId)) throw notReady();
  try {
    await device.addRecoveryKey(userId, kp);
  } catch (e) {
    throw (e as Error)?.name === 'ConstraintError' ? rerr('alreadyOpen') : e;
  }
  if (!isCurrent(userId)) {
    await device.deleteRecoveryKeyIf(userId, { publicRaw: kp.publicRaw }).catch(() => {}); // nessuna richiesta creata: la chiave non serve
    throw notReady();
  }
  let created: { id: string; fingerprint: string };
  try {
    created = await vaultApi.createRecovery(b64uEncode(kp.publicRaw), reason);
  } catch (e) {
    if (isDefiniteReject(e) && isCurrent(userId)) await device.deleteRecoveryKeyIf(userId, { publicRaw: kp.publicRaw }).catch(() => {});
    throw e;
  }
  if (!isCurrent(userId)) throw notReady(); // la chiave resta orfana: la risolvera' una sync
  if (created.fingerprint !== own) {
    await vaultApi.cancelRecovery(created.id).catch(() => {});
    await device.deleteRecoveryKeyIf(userId, { publicRaw: kp.publicRaw }).catch(() => {});
    throw rerr('releaseInvalid');
  }
  if (!(await device.bindRecoveryKeyIf(userId, kp.publicRaw, created.id))) {
    await vaultApi.cancelRecovery(created.id).catch(() => {}); // la chiave e' sparita o cambiata: la richiesta non avrebbe piu' un proprietario
    throw rerr('notThisDevice');
  }
  return created;
}

/** Richiesta di questo dispositivo (chiave locale), con l'FP proprio. null: nessuna chiave. `requestId` null: POST non ancora risolta. */
export async function localRecovery(userId: string): Promise<{ requestId: string | null; fingerprint: string } | null> {
  const key = await device.getRecoveryKey(userId);
  if (!key) return null;
  return { requestId: key.requestId, fingerprint: await fingerprintOf(key.publicRaw) };
}

/** Meta A del codice, solo in PENDING_CODE (altrimenti null). Senza la chiave di questa richiesta: notThisDevice. */
export async function readCodeA(userId: string, requestId: string): Promise<string | null> {
  const key = await device.getRecoveryKey(userId);
  if (!key || key.requestId !== requestId) throw rerr('notThisDevice');
  const r = await vaultApi.getRecovery(requestId);
  if (r.status !== 'PENDING_CODE' || !r.sealedCodeA) return null;
  const sealed = r.sealedCodeA;
  return or('notThisDevice', () => openSealedCodeA(b64uDecode(sealed), key.privateKey, requestId, userId));
}

export type SyncLocalResult = 'none' | 'active' | 'cleared' | 'unknown';

const OPEN_STATUSES = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED'];
const CLOSED_STATUSES = ['COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'];

/**
 * Allinea la chiave effimera allo stato del server, senza lock: ogni scrittura e' un compare-and-set (bind per `publicRaw`, delete per `requestId` o `publicRaw` + eta'),
 * quindi una sync vecchia non tocca una chiave nuova. Mai scritture con rete, 5xx, 401 o utente del token diverso (prima della chiamata e dopo la risposta): unknown.
 * Non tocca mai i marker del vault (kit/pin).
 */
export async function syncLocalRecovery(userId: string): Promise<SyncLocalResult> {
  const key = await device.getRecoveryKey(userId);
  if (!key) return 'none';
  if (!isCurrent(userId)) return 'unknown';
  try {
    return key.requestId === null ? await syncOrphan(userId, key) : await syncBound(userId, key.requestId);
  } catch {
    return 'unknown'; // errore IDB: niente di certo, si riprova alla prossima sync
  }
}

/** Chiave orfana (POST senza esito): la risolve il GET /keyring. Stesso FP in openRecovery -> la lega; oltre la grazia e senza openRecovery -> la cancella. */
async function syncOrphan(userId: string, key: device.RecoveryKey): Promise<SyncLocalResult> {
  let kr: KeyringDto;
  try { kr = await fetchKeyring(); } catch { return 'unknown'; }
  if (!isCurrent(userId)) return 'unknown';
  const open = kr.openRecovery;
  if (open && open.fingerprint === await fingerprintOf(key.publicRaw)) {
    return (await device.bindRecoveryKeyIf(userId, key.publicRaw, open.id)) ? 'active' : 'unknown';
  }
  const limit = Date.now() - ORPHAN_GRACE_MS;
  if ((key.createdAt ?? 0) > limit) return 'unknown'; // la POST puo' essere ancora in volo
  return (await device.deleteRecoveryKeyIf(userId, { publicRaw: key.publicRaw, olderThan: limit })) ? 'cleared' : 'unknown';
}

async function syncBound(userId: string, requestId: string): Promise<SyncLocalResult> {
  let closed = false;
  try {
    const status = (await vaultApi.getRecovery(requestId)).status;
    if (OPEN_STATUSES.includes(status)) return isCurrent(userId) ? 'active' : 'unknown';
    closed = CLOSED_STATUSES.includes(status);
  } catch (e) {
    closed = isNotFound(e);
  }
  if (!closed || !isCurrent(userId)) return 'unknown';
  return (await device.deleteRecoveryKeyIf(userId, { requestId })) ? 'cleared' : 'unknown';
}

// ---------------------------------------------------------------- T6: completamento («commit, poi Kit»)

/**
 * Esito del complete. `applied`: il server ha committato il NOSTRO payload e c'e' il nuovo Kit (20 B, lo azzera chi lo mostra). `appliedWithoutKit`: il recupero e' stato committato da un
 * tentativo PRECEDENTE della stessa richiesta, quindi il Kit di questo tentativo non vale: vale il PIN di quel tentativo (non di questo), si sblocca con quello e si rigenera il Kit.
 * `appliedKitReplaced`: il 200 e' di QUESTO tentativo (vale il PIN appena scelto, lo store e' gia' sbloccato) ma il keyring ha poi un altro escrow (sostituito da un'altra sessione dopo il commit): il Kit di questo tentativo non vale, si rigenera. `notApplied`: nulla e' cambiato, vale il Kit
 * precedente. `completedElsewhere`: un'altra sessione ha completato il recupero. `completedUnverified`: la richiesta e' COMPLETED ma il keyring o i marker non si sono potuti leggere, quindi non si sa quale escrow/PIN valga (il Kit precedente non vale piu').
 * `unknown`: lo stato della richiesta non e' noto, decide il marker `kit` al riavvio. `key`: chiave i18n del messaggio.
 */
export interface CompleteResult {
  verdict: 'applied' | 'appliedWithoutKit' | 'appliedKitReplaced' | 'notApplied' | 'completedElsewhere' | 'completedUnverified' | 'unknown';
  reason?: 'keyringChanged' | 'requestClosed' | 'rejected';
  key?: string;
  kit?: Uint8Array;
  /** Solo con `applied`: hash dell'escrow del Kit restituito; la UI lo passa a confirmKit(userId, escrowHash). */
  escrowHash?: string;
}

const notApplied = (reason: NonNullable<CompleteResult['reason']>): CompleteResult => ({ verdict: 'notApplied', reason, key: errorKey(reason) });
const UNKNOWN: CompleteResult = { verdict: 'unknown', key: errorKey('unknown') };
const COMPLETED_UNVERIFIED: CompleteResult = { verdict: 'completedUnverified', key: errorKey('completedUnverified') };
const COMPLETED_ELSEWHERE: CompleteResult = { verdict: 'completedElsewhere', key: errorKey('completedElsewhere') };
const APPLIED_WITHOUT_KIT: CompleteResult = { verdict: 'appliedWithoutKit', key: errorKey('appliedWithoutKit') };
const APPLIED_KIT_REPLACED: CompleteResult = { verdict: 'appliedKitReplaced', key: errorKey('appliedKitReplaced') };

/** COMMITTED = il keyring ha il NOSTRO escrow: il commit e' avvenuto e il Kit (ancora in memoria) e' quello giusto. */
const COMMITTED = 'committed' as const;
type Verdict = CompleteResult | typeof COMMITTED;

/**
 * Richiesta COMPLETED: si decide sempre col GET /keyring. Hash del tentativo corrente (`own`, col Kit in memoria) -> committed. Hash di un NOSTRO marker `recovery` della stessa richiesta
 * (un tentativo precedente, il cui Kit non esiste piu') -> appliedWithoutKit. Altro -> completedElsewhere. GET o lettura dei marker falliti -> completedUnverified (la richiesta e' COMPLETED: mai `unknown`, che direbbe che vale il Kit precedente).
 * Residuo noto (U12): escrow sostituito da altri tra il commit e un retry con 409 -> completedElsewhere, anche se il PIN nuovo vale.
 */
async function completedVerdict(userId: string, requestId: string, own: string | null): Promise<Verdict> {
  let kr: KeyringDto;
  let markers: device.KitMarker[];
  try {
    kr = await fetchKeyring();
    markers = await device.listKitMarkers(userId);
  } catch {
    return COMPLETED_UNVERIFIED;
  }
  if (!isCurrent(userId)) throw notReady(); // la GET e' del token di un altro utente: il suo escrowHash non dice nulla del nostro commit
  if (own && kr.escrowHash === own) return COMMITTED;
  const ours = !!kr.escrowHash && markers.some((m) => m.origin === 'recovery' && m.requestId === requestId && m.escrowHash === kr.escrowHash);
  return ours ? APPLIED_WITHOUT_KIT : COMPLETED_ELSEWHERE;
}

/** 409: il GET della richiesta dice perche'. GET fallita o stato inatteso: unknown. */
async function classify409(userId: string, requestId: string, ownEscrowHash: string): Promise<Verdict> {
  let status: string;
  try {
    status = (await vaultApi.getRecovery(requestId)).status;
  } catch (e) {
    if (!isNotFound(e)) return UNKNOWN;
    if (!isCurrent(userId)) throw notReady(); // il 404 e' del token di un altro utente: non dice nulla della nostra richiesta
    return notApplied('requestClosed');
  }
  if (status === 'RELEASED') return notApplied('keyringChanged');
  if (status === 'COMPLETED') return completedVerdict(userId, requestId, ownEscrowHash);
  if (['EXPIRED', 'CANCELLED', 'REJECTED'].includes(status)) return notApplied('requestClosed');
  return UNKNOWN;
}

/**
 * Esito dopo il fallimento della POST. `ambiguous`: un tentativo precedente (rete/5xx/429) puo' essere stato applicato, quindi nessun rifiuto successivo (4xx o 503 del vault)
 * vale notApplied senza guardare la richiesta: COMPLETED -> regola del keyring; altro -> tabella. Un 503 senza body del vault (proxy) non e' un rifiuto: unknown.
 */
async function classify(userId: string, e: unknown, requestId: string, ownEscrowHash: string, ambiguous: boolean): Promise<Verdict> {
  if (!isApiError(e)) return UNKNOWN;
  if (!isCurrent(userId)) throw notReady(); // prima di interpretare qualunque risposta (404 compreso): il token e' di un altro utente
  if (e.status === 409) return classify409(userId, requestId, ownEscrowHash);
  const rejected = isNotFound(e) || [400, 403, 413, 422].includes(e.status) || isVault503(e);
  if (!rejected) return UNKNOWN; // 401, rete/5xx/429 dopo i tentativi, 503 di proxy, altri
  if (ambiguous) {
    try {
      const status = (await vaultApi.getRecovery(requestId)).status;
      if (status === 'COMPLETED') return await completedVerdict(userId, requestId, ownEscrowHash);
    } catch (g) {
      if (!isNotFound(g)) return UNKNOWN;
      if (!isCurrent(userId)) throw notReady();
    }
  }
  return notApplied(isNotFound(e) ? 'requestClosed' : 'rejected');
}

/** Preparazione: la richiesta risulta gia' COMPLETED (nessun tentativo corrente, nessun Kit in memoria). Mai releaseInvalid: nostro marker `recovery` coincidente col keyring -> appliedWithoutKit, altrimenti completedElsewhere. */
const completedAtStart = async (userId: string, requestId: string): Promise<CompleteResult> => {
  const v = await completedVerdict(userId, requestId, null);
  return v === COMMITTED ? COMPLETED_UNVERIFIED : v; // senza hash proprio COMMITTED non puo' uscire
};

/**
 * Passi dopo il 200 (tutti best-effort: il server ha committato). Ordine: GET del keyring + cache (solo utente corrente, solo dal server, anche se non esisteva), sblocco, share, purge, chiave effimera.
 * `ours` false = il keyring ha un escrow diverso dal nostro (200 idempotente con keyring cambiato nel frattempo): il Kit di questo tentativo non vale.
 * Lo share nuovo si salva solo se il refresh e' riuscito (altrimenti cache vecchia + share nuovo): se no si cancella. Non cancella mai il marker `kit`: lo risolve checkPendingOnStart.
 */
async function afterCommit(userId: string, requestId: string, keys: VaultKeys, epoch: number, newShare: Uint8Array, wrappedVkSigKey: string, ownEscrowHash: string, baseRev: number): Promise<{ ours: boolean; unverified: boolean }> {
  let ours = true;
  let unverified = false;
  let refreshed = false;
  await step('refresh', async () => {
    if (!isCurrent(userId)) return;
    const kr = await fetchKeyring();
    if (!isCurrent(userId)) return; // la risposta e' del token di un altro utente: ignorata
    if (kr.escrowHash !== ownEscrowHash) {
      ours = false;
      // un 2xx che non viene dal vault (proxy, captive portal) non e' un commit: l'escrow diverso si crede solo se la richiesta e' COMPLETED o il keyring ha fatto 2 rev (commit + altra modifica)
      unverified = kr.rev < baseRev + 2; // se la GET lancia resta non verificato
      if (unverified) unverified = (await vaultApi.getRecovery(requestId)).status !== 'COMPLETED';
      if (unverified || !isCurrent(userId)) return;
    }
    // come unlockOnline: la cache si scrive dal server anche se mancava (dispositivo nuovo, o dopo "Rimuovi vault"), PRIMA dello sblocco
    cacheKeyring(userId, kr, store().byUser[userId]?.offlineUnlock ?? false);
    refreshed = true;
  });
  if (unverified) return { ours, unverified }; // niente sblocco, share, purge ne' cancellazione della chiave: il commit non e' provato
  await step('unlock', () => { if (isCurrent(userId)) store().unlock(userId, keys, epoch); });
  await step('share', async () => {
    if (!isCurrent(userId)) return; // utente cambiato durante la POST: lo share non e' piu' roba nostra
    if (!refreshed || !(store().byUser[userId]?.offlineUnlock ?? false)) { await device.deleteShare(userId); return; }
    // saveDeviceShare non lancia: false = non salvato; lo share vecchio ha il serverShare ruotato, meglio nessuno
    if (!(await saveDeviceShare(userId, newShare, epoch, b64uDecode(wrappedVkSigKey)))) await device.deleteShare(userId);
  });
  await step('purge', () => purgeApiCache());
  await step('key', () => device.deleteRecoveryKeyIf(userId, { requestId }));
  return { ours, unverified };
}

/**
 * Cerimonia completa sotto il lock (solo per la durata della chiamata): verifica del rilascio, Kit vecchio -> VK, nuovo PIN, nuovo Kit e nuovo serverShare,
 * round-trip, vkProof. Poi marker `kit` {origin:'recovery', requestId, epoch, rev} (uno per tentativo: nessun altro flusso lo tocca, e questo codice non lo cancella mai)
 * PRIMA della POST; POST con 3 tentativi sui transitori (stesso body). Solo sul 200 sblocca, aggiorna cache e share dal server, cancella la chiave effimera e restituisce il Kit
 * (se il keyring non ha piu' il nostro escrow: appliedKitReplaced; commit di un tentativo precedente: appliedWithoutKit). Ogni altro esito: Kit azzerato e nulla scritto in IDB oltre al marker.
 * Errori di preparazione (nessuna POST): VaultRecoveryError releaseInvalid | kitInvalid | notThisDevice | keyringChanged | busy.
 * 200 ma utente cambiato: nessuno sblocco, Kit azzerato, VaultSessionError notReady (il marker resta).
 */
export function completeRecovery(args: { userId: string; requestId: string; kit: string; newPin: string; retryDelaysMs?: readonly number[] }): Promise<CompleteResult> {
  return withLock(args.userId, () => runComplete(args));
}

async function runComplete(args: { userId: string; requestId: string; kit: string; newPin: string; retryDelaysMs?: readonly number[] }): Promise<CompleteResult> {
  const { userId, requestId } = args;
  if (!isCurrent(userId)) throw notReady(); // prima della prima GET: un 404 di un altro utente non deve sembrare "richiesta chiusa"
  const delays = args.retryDelaysMs ?? RETRY_DELAYS_MS;
  const key = await device.getRecoveryKey(userId);
  const mine = !!key && key.requestId === requestId;
  // getRecovery PRIMA del controllo della chiave (U7): una richiesta COMPLETED con la chiave gia' cancellata da una sync non e' "un altro dispositivo"
  let r: RecoveryDto;
  try {
    r = await vaultApi.getRecovery(requestId);
  } catch (e) {
    if (isNotFound(e)) {
      if (!isCurrent(userId)) throw notReady();
      if (!mine) throw rerr('notThisDevice');
      return notApplied('requestClosed');
    }
    throw e;
  }
  if (r.status === 'COMPLETED') return completedAtStart(userId, requestId);
  if (['EXPIRED', 'CANCELLED', 'REJECTED'].includes(r.status)) return notApplied('requestClosed'); // anche con la chiave gia' pulita da una sync: ne' releaseInvalid ne' notThisDevice
  if (!key || !mine) throw rerr('notThisDevice');
  const own = await fingerprintOf(key.publicRaw);
  if (['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING'].includes(r.status)) throw rerr('notReleased'); // richiesta sana, solo non ancora rilasciata: non va annullata
  if (r.status !== 'RELEASED' || r.fingerprint !== own || !r.rootShareForClient || !r.rootSignature || !r.notBefore) throw rerr('releaseInvalid');
  if (!r.escrowBlob) throw rerr('keyringChanged'); // RELEASED senza escrow: il keyring non e' READY
  const kr = await fetchKeyring();
  if (kr.status !== 'READY' || !kr.rootKeyId || !kr.wrappedVkSigKey) throw rerr('keyringChanged');
  if (!Object.prototype.hasOwnProperty.call(VAULT_ROOT_KEYS, kr.rootKeyId)) throw rerr('releaseInvalid');
  const rootShareForClient = await or('releaseInvalid', () => b64uDecode(r.rootShareForClient!));
  const escrowBlob = await or('releaseInvalid', () => b64uDecode(r.escrowBlob!));
  const rootSignature = await or('releaseInvalid', () => b64uDecode(r.rootSignature!));
  const ok = await verifyRelease({
    rootShareForClient, signature: rootSignature, requestId, userId, notBefore: r.notBefore, ownPubRaw: key.publicRaw,
    ecdsaSpki: b64uDecode(VAULT_ROOT_KEYS[kr.rootKeyId].ecdsaSpki),
  });
  if (!ok) throw rerr('releaseInvalid');
  if ((await sha256hexBytes(escrowBlob)) !== kr.escrowHash) throw rerr('keyringChanged'); // richiesta e keyring non sono piu' lo stesso istante
  const rootKey = getActiveRootKey();
  if (!rootKey) throw notReady();

  let sRoot: Uint8Array | null = null;
  let kitBytes: Uint8Array | null = null;
  let vkRaw: Uint8Array | null = null;
  let S: Uint8Array | null = null;
  const newSRoot = rnd(32);
  const newSUser = rnd(20);
  const newShare = rnd(32);
  const newSalt = rnd(16);
  let check1: Uint8Array | null = null;
  let check2: Uint8Array | null = null;
  let returned = false;
  try {
    sRoot = await or('releaseInvalid', () => openRecoveryShare(rootShareForClient, key.privateKey, requestId, userId));
    const oldKit = kitBytes = await or('kitInvalid', () => parseKit(args.kit));
    vkRaw = await or('kitInvalid', async () => unwrapEscrow(await deriveRk(sRoot!, oldKit, userId), escrowBlob, userId, kr.epoch, kr.rootKeyId!));
    const vk = await importVk(vkRaw);
    const sigKey = await or('keyringChanged', () => unwrapVkSigKey(vk, b64uDecode(kr.wrappedVkSigKey!), userId, kr.epoch));

    const kdf = { m: DEFAULT_KDF.m, t: DEFAULT_KDF.t, p: DEFAULT_KDF.p };
    S = await deriveS(args.newPin, newSalt, kdf);
    const built = await buildRecoveryPayload({
      userId, epoch: kr.epoch, rev: kr.rev, vkRaw, S, pinSalt: newSalt, serverShare: newShare, kdf, sRoot: newSRoot, sUser: newSUser, rootKey,
    });

    // Round-trip a runtime: il nuovo wrap col nuovo PIN e il nuovo escrow col nuovo Kit devono restituire la stessa VK, altrimenti niente marker e niente POST.
    try {
      const o = JSON.parse(built.payload) as { wrap: { pinSalt: string; wrappedVkPin: string; serverShare: string; kdfParams: typeof kdf }; escrow: { escrowBlob: string; rootKeyId: string } };
      const kek = await deriveKekPin(S, b64uDecode(o.wrap.serverShare), b64uDecode(o.wrap.pinSalt), userId);
      check1 = await unwrapVkPin(kek, b64uDecode(o.wrap.wrappedVkPin), userId, kr.epoch, o.wrap.kdfParams);
      check2 = await unwrapEscrow(await deriveRk(newSRoot, newSUser, userId), b64uDecode(o.escrow.escrowBlob), userId, kr.epoch, o.escrow.rootKeyId);
      if (!sameBytes(check1, vkRaw) || !sameBytes(check2, vkRaw)) throw new Error('roundTripMismatch');
    } catch {
      throw new VaultSessionError('keyringInvalid', 'errors.common.unknownError');
    }
    const proof = await signVkProof(sigKey, userId, kr.epoch, kr.rev, built.payload, `POST /api/vault/recovery/${requestId}/complete`);

    // Marker PRIMA della POST (come setup e regenerateKit), uno per escrow: se non si scrive, nessun Kit puo' andare perso e non si invia nulla.
    // (epoch, rev) sono quelli del keyring su cui e' costruito il payload: il resolver lo cancella solo quando il keyring li ha superati (il server non puo' piu' committarlo).
    if (!isCurrent(userId)) throw notReady();
    await device.addKitMarker(userId, { kind: 'kit', escrowHash: built.escrowHash, epoch: kr.epoch, rev: kr.rev, origin: 'recovery', requestId });

    const failure = await postWithRetries(userId, requestId, built.payload, b64uEncode(proof), delays);
    if (failure.error !== undefined) {
      const v = await classify(userId, failure.error, requestId, built.escrowHash, failure.ambiguous);
      if (v !== COMMITTED) return v;
    }

    const after = await afterCommit(userId, requestId, { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey }, kr.epoch, newShare, kr.wrappedVkSigKey, built.escrowHash, kr.rev);
    if (!isCurrent(userId)) throw notReady(); // cambio utente o logout durante la POST: niente Kit a chi non e' piu' l'utente
    if (after.unverified) return UNKNOWN; // 200 senza prova di commit: nulla e' stato sbloccato ne' cancellato, decide il marker al riavvio
    if (!after.ours) return APPLIED_KIT_REPLACED; // il 200 e' nostro (PIN nuovo valido, store sbloccato) ma il Kit di questo tentativo e' stato sostituito: il finally lo azzera
    returned = true;
    return { verdict: 'applied', kit: newSUser, escrowHash: built.escrowHash };
  } finally {
    zero(sRoot, kitBytes, vkRaw, S, newSRoot, newShare, check1, check2);
    if (!returned) zero(newSUser);
  }
}

/**
 * POST con fino a 1 + delays.length tentativi sui transitori, sempre lo stesso body. `error` assente = 200 (anche idempotente).
 * `ambiguous`: almeno un tentativo e' finito in rete/5xx/429 (puo' essere stato applicato). Prima di ogni POST l'utente del token deve essere ancora quello: altrimenti notReady.
 */
async function postWithRetries(userId: string, requestId: string, payload: string, vkProof: string, delays: readonly number[]): Promise<{ error?: unknown; ambiguous: boolean }> {
  let ambiguous = false;
  for (let i = 0; ; i++) {
    if (!isCurrent(userId)) throw notReady();
    try {
      await vaultApi.completeRecovery(requestId, payload, vkProof);
      return { ambiguous };
    } catch (e) {
      if (!isTransient(e)) return { error: e ?? new Error('unknown'), ambiguous };
      ambiguous = true;
      if (i >= delays.length) return { error: e ?? new Error('unknown'), ambiguous };
      await sleep(delays[i]);
    }
  }
}
