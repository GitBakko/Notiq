// Vault v3: flussi di sessione del piano P2 §5.4 (setup, sblocco online/offline, cambio PIN, Kit, interruttore offline).
// Nessuna UI. I byte grezzi (VK, S, pkcs8, S_root, serverShare) vivono solo dentro le funzioni e si azzerano con fill(0).
// Il Kit (S_user, 20 B) lo restituiscono solo setup e rotateVault DOPO la risposta 2xx del server: chi lo mostra lo
// tiene nello stato del componente e fa fill(0) a fine cerimonia, poi chiama confirmKit.
import * as vaultApi from './vaultApi';
import type { OpenRecovery, VaultApiError } from './vaultApi';
import { purgeApiCache } from './apiCache';
import { db } from './db';
import * as device from './deviceKeyStore';
import { useVaultStore, type VaultKeys } from '../store/vaultStore';
import { useAuthStore } from '../store/authStore';
import { DEFAULT_KDF, deriveS, type KdfParams } from '../utils/argon2';
import {
  b64uDecode, b64uEncode, decryptItem, decryptShare, deriveAuthKey, deriveKekPin, deriveNoteKey, deriveRk, encryptItem, encryptShare,
  generateSigKey, generateVkRaw, importVk, sealRootShare, sha256hexBytes, signVkProof, unwrapEscrow, unwrapPrevVk, unwrapVkPin,
  unwrapVkSigKey, wrapEscrow, wrapPrevVk, wrapUserShare, wrapVkPin, wrapVkSigKey, type VaultKey,
} from '../utils/vaultCrypto';

/** Chiave pubblica root fissata (utils/vaultRootKeys.ts, T25): la passa il chiamante. */
export interface RootKeyInfo {
  id: string;
  ecdhSpki: Uint8Array;
}

/** Risposta di GET /api/vault/keyring (forma del service backend). */
export interface KeyringDto {
  status: 'NONE' | 'READY' | 'RESET_PENDING';
  epoch: number;
  rev: number;
  kdf: string | null;
  kdfParams: KdfParams | null;
  pinSalt: string | null;
  wrappedVkPin: string | null;
  wrappedVkSigKey: string | null;
  rootKeyId: string | null;
  lockedUntil: string | null;
  escrowHash: string | null;
  legacyCount: number;
  openRecovery?: OpenRecovery | null;
  /** Un recupero rilasciato e poi annullato o scaduto: il Kit attuale va sostituito (Fase 4, F2). */
  kitRotationRequired?: boolean;
  /** 1.15.1: l'escrow e' sigillato con una chiave root ritirata (rootKeyId fuori dalla mappa del server): serve rigenerare il Kit. Assente con un server precedente. */
  rootKeyRetired?: boolean;
  /** AES-GCM(VK_new, VK_old) dell'ultima rotazione (b64url, 60 B); null prima della prima. Assente con un server precedente alla rotazione. */
  prevVkWrap?: string | null;
  /** Note vault ancora a un'epoch precedente: > 0 = rotazione da finire, e il server rifiuta una nuova rotazione (409 rotationPending). */
  staleCount?: number;
}

export type VaultSessionCode =
  | 'wrongPin' // 403 allo sblocco, o tag GCM offline
  | 'pinLocked' // 429 o lockedUntil nel futuro
  | 'notReady'
  | 'vaultLocked' // operazione che richiede il vault sbloccato
  | 'offlineUnavailable'
  | 'kitNotUpdated'
  | 'recoveryInProgress' // 409 con recupero aperto (fino a 7 giorni): il Kit si rigenera dopo
  | 'rotationPending' // note ancora a un'epoch precedente: prima si finisce la rotazione in corso, poi se ne fa un'altra
  | 'epochChanged' // il keyring e' a un'epoch che la sessione non ha in memoria (rotazione fatta altrove): vault bloccato, si riapre online
  | 'keyringRollback' // il keyring del server ha un'epoch piu' bassa di quella in cache su questo dispositivo (backup ripristinato): non si sblocca
  | 'localPending' // envelope locali non sincronizzati di un'altra epoch: rotare li renderebbe illeggibili
  | 'pinChangedElsewhere' // changePin al 409: il wrap e' cambiato altrove (recupero o altro cambio PIN), niente da rimandare
  | 'serverOutdated' // GET /keyring senza staleCount (backend 1.14): scarterebbe rotate/serverShare in silenzio
  | 'keyringInvalid';

/** `key` e' una chiave i18n; `lockedUntil` solo per pinLocked. */
export class VaultSessionError extends Error {
  code: VaultSessionCode;
  key: string;
  lockedUntil: string | null;
  constructor(code: VaultSessionCode, key: string, lockedUntil: string | null = null) {
    super(key);
    this.name = 'VaultSessionError';
    this.code = code;
    this.key = key;
    this.lockedUntil = lockedUntil;
  }
}

const store = () => useVaultStore.getState();
/** Rotazione propria in corso dalla PUT al commit locale (azzerato in finally di rotateVault): `syncKeyringCache` non blocca per l'epoch che stiamo creando. */
let rotating = false;
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const plainKdf = (k: KdfParams): KdfParams => ({ m: k.m, t: k.t, p: k.p });
const vaultKdf = (k: KdfParams) => ({ m: k.m, t: k.t, p: 1 as const });
const isApiError = (e: unknown): e is VaultApiError => !!e && typeof e === 'object' && (e as VaultApiError).name === 'VaultApiError';
/** Il server ha risposto con un rifiuto: la richiesta NON e' stata applicata. 5xx diversi da 503 e rete restano ambigui; un 503 conta solo se viene dal vault (body errors.*), non da un proxy (U10). */
const isDefiniteReject = (e: unknown) => isApiError(e) && ((e.status >= 400 && e.status < 500) || (e.status === 503 && e.fromServer === true));
/** Il token e' ancora dell'utente dell'operazione: va controllato prima di ogni GET e dopo ogni risposta. */
const isCurrent = (userId: string) => useAuthStore.getState().user?.id === userId;
const zero = (...bufs: (Uint8Array | null | undefined)[]) => { for (const b of bufs) b?.fill(0); };

const fetchKeyring = () => vaultApi.getKeyring<KeyringDto>();
/** La 1.15 manda sempre staleCount, la 1.14 mai: senza, la sua PUT /keyring scarterebbe in silenzio rotate e wrap.serverShare (lockout dopo la rotazione). */
const assertRotationServer = (kr: { staleCount?: number }) => { if (typeof kr.staleCount !== 'number') throw new VaultSessionError('serverOutdated', 'errors.vault.serverOutdated'); };

/** Scrittura della cache PRIMA di aver verificato il PIN (AEAD di wrappedVkPin): mai con un'epoch oltre quella verificata in cache, e mai senza una cache (B5). */
export function cacheUnverified(userId: string, kr: KeyringDto, offline: boolean) {
  const c = store().byUser[userId];
  if (c && kr.epoch === c.epoch) cacheKeyring(userId, kr, offline);
}

export function cacheKeyring(userId: string, kr: KeyringDto, offlineUnlock: boolean) {
  if (kr.status !== 'READY' || !kr.kdfParams || !kr.pinSalt || !kr.wrappedVkPin || !kr.wrappedVkSigKey || !kr.rootKeyId) {
    throw new VaultSessionError('keyringInvalid', 'errors.common.unknownError');
  }
  store().setKeyringCache(userId, {
    status: 'READY',
    epoch: kr.epoch,
    rev: kr.rev,
    kdf: kr.kdf ?? 'argon2id',
    kdfParams: kr.kdfParams,
    pinSalt: kr.pinSalt,
    wrappedVkPin: kr.wrappedVkPin,
    rootKeyId: kr.rootKeyId,
    offlineUnlock,
  });
}

/**
 * Allinea la cache al keyring del server (J.6): un cambio PIN fatto da un altro dispositivo alza `rev`, e senza questo
 * il vecchio PIN continuerebbe a sbloccare offline. Solo avanti per `rev` a PARITA' di epoch: una GET partita prima di un cambio
 * PIN locale non riporta indietro la cache. L'epoch della cache NON sale mai da qui (B5): sale solo dopo l'unwrap AEAD di wrappedVkPin
 * (sblocco) o col commit di rotateVault; un'epoch non autenticata nella cache farebbe rifiutare poi il keyring vero come rollback. Senza cache o con keyring non READY/incompleto non fa nulla.
 * Limite intrinseco: un dispositivo sempre offline non vede il cambio.
 */
export function syncKeyringCache(userId: string, kr: KeyringDto): void {
  const c = store().byUser[userId];
  if (!c || kr.status !== 'READY') return;
  // Rotazione fatta altrove: le chiavi in memoria sono di un'epoch che il server non accetta piu' (il PIN invariato riapre l'epoch nuova allo sblocco online).
  // Non vale durante la rotazione di QUESTA sessione (dalla PUT al commit locale): l'epoch piu' alta e' la nostra e il commit sta per allinearsi.
  const s = store();
  if (!rotating && s.unlockedUserId === userId && s.epoch !== null && kr.epoch > s.epoch) void s.lockVault();
  // Epoch del server oltre quella verificata: la cache NON sale, ma lo share del dispositivo si cancella: lo sblocco offline aprirebbe la VK vecchia (offlineUnavailable fino a uno sblocco online).
  if (kr.epoch > c.epoch) void device.deleteShare(userId).catch(() => {});
  if (!(kr.epoch === c.epoch && kr.rev > c.rev)) return;
  try { cacheKeyring(userId, kr, c.offlineUnlock); } catch { /* keyring incompleto: cache invariata */ }
}

/** GET del keyring + `syncKeyringCache`; errori di rete o server ignorati (best effort). Restituisce il keyring letto (undefined se la GET e' fallita). */
export async function refreshKeyringCache(userId: string): Promise<KeyringDto | undefined> {
  try {
    const kr = await fetchKeyring();
    syncKeyringCache(userId, kr);
    return kr;
  } catch { /* offline o server giu': cache invariata */ }
}

const wrappedHash = (b64: string) => sha256hexBytes(b64uDecode(b64));

/** Share cifrato col device key (+ wrappedVkSigKey per lo sblocco offline). Un errore IDB spegne lo sblocco offline (false), non blocca il flusso. */
export async function saveDeviceShare(userId: string, serverShare: Uint8Array, epoch: number, wrappedVkSigKey: Uint8Array): Promise<boolean> {
  try {
    const devKey = await device.getOrCreateDeviceKey(userId);
    const shareEnc = await encryptShare(devKey, serverShare, userId, epoch);
    await device.putShare(userId, { epoch, shareEnc, wrappedVkSigKey });
    return true;
  } catch {
    store().setOfflineUnlock(userId, false);
    return false;
  }
}

interface Opened {
  /** Il keyring con cui si e' aperto: dopo un 409 staleRev e' quello riletto, non quello passato. */
  kr: KeyringDto;
  vkRaw: Uint8Array;
  vk: VaultKey;
  /** VK dell'epoch precedente, se il keyring ha prevVkWrap e si apre. Senza (D4, unwrap fallito) le note stale restano illeggibili e le gestisce D6. */
  prev?: VaultKey;
  sigKey: CryptoKey;
  serverShare: Uint8Array;
  wrappedSig: Uint8Array;
}

/**
 * Sblocco online fino a VK/sigKey. Il chiamante azzera vkRaw e serverShare.
 * /unlock porta `rev` del keyring letto: se una rotazione o un cambio PIN l'ha superato risponde 409 staleRev senza contare il tentativo
 * (l'authKey del salt vecchio sarebbe un falso PIN errato); allora si rilegge il keyring e si ritenta UNA volta (Argon2 rifatta).
 */
async function openKeyring(userId: string, pin: string, kr: KeyringDto, retry = true): Promise<Opened> {
  if (kr.status !== 'READY') throw new VaultSessionError('notReady', 'errors.vault.notReady');
  const verified = store().byUser[userId];
  if (verified && kr.epoch < verified.epoch) throw new VaultSessionError('keyringRollback', 'errors.vault.keyringRollback'); // vale anche per il keyring riletto dopo un 409
  if (kr.lockedUntil && Date.parse(kr.lockedUntil) > Date.now()) {
    throw new VaultSessionError('pinLocked', 'errors.vault.locked', kr.lockedUntil);
  }
  if (!kr.kdfParams || !kr.pinSalt || !kr.wrappedVkPin || !kr.wrappedVkSigKey || !kr.rootKeyId) {
    throw new VaultSessionError('keyringInvalid', 'errors.common.unknownError');
  }
  const { epoch } = kr;
  const params = plainKdf(kr.kdfParams);
  const salt = b64uDecode(kr.pinSalt);
  // deriveS controlla i kdfParams del server prima di derivare
  const S = await deriveS(pin, salt, params);
  let serverShare: Uint8Array | null = null;
  let vkRaw: Uint8Array | null = null;
  try {
    const authKey = await deriveAuthKey(S, userId);
    let res: { serverShare: string };
    try {
      res = await vaultApi.unlock(b64uEncode(authKey), kr.rev);
    } finally {
      zero(authKey);
    }
    serverShare = b64uDecode(res.serverShare);
    const kek = await deriveKekPin(S, serverShare, salt, userId);
    vkRaw = await unwrapVkPin(kek, b64uDecode(kr.wrappedVkPin), userId, epoch, params);
    const vk = await importVk(vkRaw);
    const wrappedSig = b64uDecode(kr.wrappedVkSigKey);
    const sigKey = await unwrapVkSigKey(vk, wrappedSig, userId, epoch);
    let prev: VaultKey | undefined;
    if (kr.prevVkWrap && epoch > 0) {
      try {
        prev = await unwrapPrevVk(vk, b64uDecode(kr.prevVkWrap), userId, epoch, epoch - 1);
      } catch {
        console.warn('[vaultSession] prevVkWrap non apribile: sblocco senza la VK precedente'); // niente byte ne' errori di crypto nel log
      }
    }
    return { kr, vkRaw, vk, prev, sigKey, serverShare, wrappedSig };
  } catch (e) {
    zero(vkRaw, serverShare);
    if (isApiError(e)) {
      if (e.status === 403) throw new VaultSessionError('wrongPin', e.key);
      if (e.status === 429) {
        // lockedUntil del server (P1:625); se la GET fallisce resta senza data
        let until: string | null = null;
        try { until = (await fetchKeyring()).lockedUntil; } catch { /* nessuna data */ }
        throw new VaultSessionError('pinLocked', e.key, until);
      }
      if (e.status === 409) {
        if (retry && e.key === 'errors.vault.staleRev') return await openKeyring(userId, pin, await fetchKeyring(), false);
        try { const fresh = await fetchKeyring(); if (fresh.status === 'READY') cacheUnverified(userId, fresh, store().byUser[userId]?.offlineUnlock ?? false); } catch { /* cache invariata */ }
        throw new VaultSessionError('notReady', e.key);
      }
    }
    throw e;
  } finally {
    zero(S);
  }
}

// ---------------------------------------------------------------- setup

/** offlineSaved: false solo se lo sblocco offline era richiesto e lo share non e' stato salvato (la UI lo segnala). escrowHash: chiave del marker `kit`, da passare a confirmKit. */
export type SetupResult = { ok: true; kit: Uint8Array; offlineSaved: boolean; escrowHash: string } | { ok: false; reason: 'alreadySetup' };

/**
 * Setup (solo online). Il Kit si restituisce SOLO dopo il 201. Marker `kit` {origin:'setup', rev:null} (uno per escrow) salvato prima della POST e cancellato
 * subito su 400/403/503 (e su ogni altro rifiuto definitivo); resta su errori ambigui (rete, 5xx) per il controllo al riavvio.
 */
export async function setup(args: { userId: string; pin: string; password: string; rootKey: RootKeyInfo; offlineUnlock?: boolean }): Promise<SetupResult> {
  const { userId, pin, password, rootKey } = args;
  const offline = args.offlineUnlock ?? false;
  const kr0 = await fetchKeyring();
  if (kr0.status === 'READY') {
    cacheUnverified(userId, kr0, store().byUser[userId]?.offlineUnlock ?? false); // il keyring non l'abbiamo creato noi
    return { ok: false, reason: 'alreadySetup' };
  }
  if (kr0.status === 'RESET_PENDING') throw new VaultSessionError('notReady', 'errors.vault.notReady');
  const epoch = kr0.epoch;
  const kdf = plainKdf(DEFAULT_KDF);
  const pinSalt = rnd(16);
  const serverShare = rnd(32);
  const sRoot = rnd(32);
  const sUser = rnd(20);
  const vkRaw = generateVkRaw();
  let S: Uint8Array | null = null;
  let authKey: Uint8Array | null = null;
  let pkcs8: Uint8Array | null = null;
  let sent = false;
  let escrowHash: string | null = null;
  try {
    S = await deriveS(pin, pinSalt, kdf);
    authKey = await deriveAuthKey(S, userId);
    const kek = await deriveKekPin(S, serverShare, pinSalt, userId);
    const wrappedVkPin = await wrapVkPin(kek, vkRaw, userId, epoch, kdf);
    const vk = await importVk(vkRaw);
    const sig = await generateSigKey();
    pkcs8 = sig.pkcs8;
    const wrappedVkSigKey = await wrapVkSigKey(vk, pkcs8, userId, epoch);
    const rk = await deriveRk(sRoot, sUser, userId);
    const escrowBlob = await wrapEscrow(rk, vkRaw, userId, epoch, rootKey.id);
    const sealedRootShare = await sealRootShare(sRoot, rootKey.ecdhSpki, userId, epoch, rootKey.id);
    const userShareUnderVk = await wrapUserShare(vk, sUser, userId, epoch);

    // marker PRIMA della POST: se non si salva, nessun Kit puo' andare perso, quindi si abbandona
    escrowHash = await sha256hexBytes(escrowBlob);
    await device.addKitMarker(userId, { kind: 'kit', escrowHash, epoch, rev: null, origin: 'setup' });
    sent = true;
    let created: { epoch: number; rev: number };
    try {
      created = await vaultApi.createKeyring<{ epoch: number; rev: number }>({
        expectedEpoch: epoch,
        password,
        kdf: 'argon2id',
        kdfParams: vaultKdf(kdf),
        pinSalt: b64uEncode(pinSalt),
        wrappedVkPin: b64uEncode(wrappedVkPin),
        authKey: b64uEncode(authKey),
        serverShare: b64uEncode(serverShare),
        vkSigPub: b64uEncode(sig.spki),
        wrappedVkSigKey: b64uEncode(wrappedVkSigKey),
        escrowBlob: b64uEncode(escrowBlob),
        sealedRootShare: b64uEncode(sealedRootShare),
        rootKeyId: rootKey.id,
        userShareUnderVk: b64uEncode(userShareUnderVk),
      });
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        // alreadySetup, salvo che il keyring sia il NOSTRO (POST committata e risposta persa, poi ritentata): il marker resta e si prosegue come dopo un 201
        let fresh: KeyringDto | null = null;
        try { fresh = await fetchKeyring(); } catch { /* ignora */ }
        if (!(fresh && fresh.status === 'READY' && fresh.escrowHash === escrowHash)) {
          // GET fallita: senza confronto il marker resta, lo risolve checkPending con la regola di morte
          if (fresh) await device.deleteKitMarker(userId, escrowHash).catch(() => {});
          try { if (fresh?.status === 'READY') cacheUnverified(userId, fresh, false); } catch { /* ignora */ }
          zero(sUser);
          return { ok: false, reason: 'alreadySetup' };
        }
        created = { epoch: fresh.epoch, rev: fresh.rev };
      } else {
        if (isDefiniteReject(e)) await device.deleteKitMarker(userId, escrowHash).catch(() => {});
        throw e;
      }
    }

    // 201: cache, share, unlock, purge, poi (chi chiama) il Kit
    store().setKeyringCache(userId, {
      status: 'READY',
      epoch: created.epoch ?? epoch,
      rev: created.rev,
      kdf: 'argon2id',
      kdfParams: kdf,
      pinSalt: b64uEncode(pinSalt),
      wrappedVkPin: b64uEncode(wrappedVkPin),
      rootKeyId: rootKey.id,
      offlineUnlock: offline,
    });
    const offlineSaved = offline ? await saveDeviceShare(userId, serverShare, epoch, wrappedVkSigKey) : true;
    const keys: VaultKeys = { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey: sig.privateKey };
    store().unlock(userId, keys, epoch);
    await purgeApiCache();
    return { ok: true, kit: sUser, offlineSaved, escrowHash };
  } catch (e) {
    zero(sUser);
    // errore prima della POST: nessun marker residuo
    if (!sent && escrowHash) await device.deleteKitMarker(userId, escrowHash).catch(() => {});
    throw e;
  } finally {
    zero(S, authKey, pkcs8, vkRaw, sRoot, serverShare);
  }
}

/** L'utente ha confermato i 2 gruppi del Kit: si cancella SOLO il marker di quell'escrow (ne esistono uno per escrow, anche di altri flussi). */
export const confirmKit = (userId: string, escrowHash: string) => device.deleteKitMarker(userId, escrowHash);

// ---------------------------------------------------------------- sblocco

/** Sblocco online. `offlineUnlock` assente = valore gia' in cache (default OFF). */
export async function unlockOnline(userId: string, pin: string, opts: { offlineUnlock?: boolean } = {}): Promise<{ offlineSaved: boolean }> {
  const offline = opts.offlineUnlock ?? store().byUser[userId]?.offlineUnlock ?? false;
  const kr = await fetchKeyring();
  if (kr.status !== 'READY') throw new VaultSessionError('notReady', 'errors.vault.notReady');
  const cached = store().byUser[userId];
  if (cached && kr.epoch < cached.epoch) throw new VaultSessionError('keyringRollback', 'errors.vault.keyringRollback');
  cacheUnverified(userId, kr, offline); // rev/kdf aggiornati anche con PIN sbagliato, ma l'epoch non sale prima dell'AEAD
  const o = await openKeyring(userId, pin, kr);
  try {
    const k = o.kr; // diverso da `kr` se un 409 staleRev ha fatto rileggere il keyring
    cacheKeyring(userId, k, offline); // dopo l'unwrap AEAD di wrappedVkPin: qui l'epoch puo' salire
    let offlineSaved = true;
    if (offline) offlineSaved = await saveDeviceShare(userId, o.serverShare, k.epoch, o.wrappedSig);
    else await device.deleteShare(userId).catch(() => {}); // OFF: nessuno share residuo
    const prev = o.prev && { epoch: k.epoch - 1, vkHkdf: o.prev.hkdf, vkAes: o.prev.aes };
    store().unlock(userId, { vkHkdf: o.vk.hkdf, vkAes: o.vk.aes, sigKey: o.sigKey, ...(prev && { prev }) }, k.epoch);
    store().clearLegacy();
    await purgeApiCache();
    return { offlineSaved };
  } finally {
    zero(o.vkRaw, o.serverShare);
  }
}

/** Sblocco offline: wrappedVkPin in cache + share sul dispositivo; il tag GCM verifica il PIN, nessun lockout. */
export async function unlockOffline(userId: string, pin: string): Promise<void> {
  const c = store().byUser[userId];
  if (!c || c.status !== 'READY' || !c.offlineUnlock || !c.wrappedVkPin) {
    throw new VaultSessionError('offlineUnavailable', 'errors.vault.offlineUnavailable');
  }
  let devKey: CryptoKey | null = null;
  let share: device.DeviceShare | null = null;
  try {
    [devKey, share] = await Promise.all([device.getDeviceKey(userId), device.getShare(userId)]);
  } catch { /* IndexedDB non disponibile */ }
  if (!devKey || !share || share.epoch !== c.epoch) throw new VaultSessionError('offlineUnavailable', 'errors.vault.offlineUnavailable');

  const params = plainKdf(c.kdfParams);
  const salt = b64uDecode(c.pinSalt);
  const S = await deriveS(pin, salt, params);
  let serverShare: Uint8Array | null = null;
  let vkRaw: Uint8Array | null = null;
  try {
    try {
      serverShare = await decryptShare(devKey, share.shareEnc, userId, c.epoch);
    } catch {
      throw new VaultSessionError('offlineUnavailable', 'errors.vault.offlineUnavailable'); // share o chiave del dispositivo non coerenti
    }
    const kek = await deriveKekPin(S, serverShare, salt, userId);
    try {
      vkRaw = await unwrapVkPin(kek, b64uDecode(c.wrappedVkPin), userId, c.epoch, params);
    } catch {
      throw new VaultSessionError('wrongPin', 'errors.vault.invalidPin');
    }
    const vk = await importVk(vkRaw);
    let sigKey: CryptoKey;
    try {
      sigKey = await unwrapVkSigKey(vk, share.wrappedVkSigKey, userId, c.epoch);
    } catch {
      throw new VaultSessionError('keyringInvalid', 'errors.common.unknownError'); // VK aperta (PIN giusto) ma wrappedVkSigKey locale corrotta
    }
    store().unlock(userId, { vkHkdf: vk.hkdf, vkAes: vk.aes, sigKey }, c.epoch);
  } finally {
    zero(S, serverShare, vkRaw);
  }
}

/** OFF: cancella share e wrappedVkPin (resta `offlineUnlock:false`). ON: vale dal prossimo sblocco online. */
export async function setOfflineUnlock(userId: string, enabled: boolean): Promise<void> {
  store().setOfflineUnlock(userId, enabled);
  if (!enabled) await device.deleteShare(userId);
}

/** Lato sessione: lock, byUser, chiave, share e marker. Le righe Dexie e il rifiuto con item pending sono del chiamante (T22). */
export async function removeFromDevice(userId: string, opts: { force?: boolean } = {}): Promise<void> {
  if (opts.force) await dropVaultRows(userId); // `keyringRollback`: l'unica uscita, le modifiche non sincronizzate di questo dispositivo si perdono
  store().forgetUser(userId);
  await device.removeDevice(userId);
}

/** Righe Dexie vault (note e tag) e item di coda vault dell'utente, anche non sincronizzati. Solo per `removeFromDevice({ force })`. */
async function dropVaultRows(userId: string): Promise<void> {
  await db.transaction('rw', db.notes, db.tags, db.syncQueue, async () => {
    const mine = (r: { isVault?: boolean; userId: string }) => !!r.isVault && r.userId === userId;
    const noteIds = await db.notes.filter(mine).primaryKeys();
    const tagIds = await db.tags.filter(mine).primaryKeys();
    const ids = new Set<string>([...noteIds, ...tagIds]);
    await db.syncQueue.where('userId').equals(userId)
      .filter((i) => ids.has(i.entityId) || (i.entity === 'NOTE' && (i.data?.isVault === true || (typeof i.data?.content === 'string' && i.data.content.startsWith('nv3.'))))).delete();
    await db.notes.bulkDelete(noteIds);
    await db.tags.bulkDelete(tagIds);
  });
}

// ---------------------------------------------------------------- cambio PIN, Kit

/**
 * Il keyring aperto e' di un'epoch che la sessione non ha in memoria (rotazione fatta su un altro dispositivo): scrivere un wrap con le chiavi di
 * un'altra epoch, o ruotare da qui, renderebbe illeggibili gli envelope scritti con l'epoch in memoria. Blocca il vault e lancia.
 */
async function assertEpochInMemory(kr: KeyringDto, o: Opened): Promise<void> {
  if (kr.epoch === store().epoch) return;
  zero(o.vkRaw, o.serverShare);
  await store().lockVault();
  throw new VaultSessionError('epochChanged', 'errors.vault.epochChanged');
}

/**
 * Envelope vault non sincronizzati (riga Dexie non synced o item di coda) a e-1: ruotando diventerebbero e-2, che nessuna chiave apre piu'.
 * Contano solo con `prev` in sessione (senza, non si aprono comunque); e-2, malformati e di epoch future non bloccano. Guarda solo le stringhe envelope.
 */
export async function hasForeignEpochPending(userId: string, epoch: number): Promise<boolean> {
  const prevPrefix = `nv3.${epoch - 1}.`;
  const foreign = (c: unknown) => typeof c === 'string' && c.startsWith(prevPrefix);
  const rows = await db.notes.filter((n) => n.userId === userId && !!n.isVault && n.syncStatus !== 'synced' && foreign(n.content)).count();
  if (rows > 0) return true;
  return (await db.syncQueue.filter((i) => i.entity === 'NOTE' && i.userId === userId && foreign(i.data?.content)).count()) > 0;
}

const requireUnlocked = (userId: string) => {
  if (!store().getKeysFor(userId)) throw new VaultSessionError('vaultLocked', 'errors.vault.locked');
};

/**
 * Cambio PIN (online, vault sbloccato). `currentPin` riconferma e da' VK grezza per il nuovo wrap.
 * kdfParams del nuovo wrap = DEFAULT_KDF. serverShare non cambia. Marker `pending{pin}` senza authKey ne' payload.
 * Al 409 si rilegge il keyring: stessa epoch e stesso wrappedVkPin di quando e' stato aperto (cambia solo rev) -> serverShare e VK in memoria valgono ancora, il wrap
 * si ricostruisce con la nuova rev SENZA un secondo POST /unlock (ogni /unlock conta nel lockout). Wrap o epoch cambiati (recupero o altro cambio PIN altrove):
 * pinChangedElsewhere, nulla scritto.
 */
export async function changePin(args: { userId: string; currentPin: string; newPin: string }): Promise<void> {
  const { userId, currentPin, newPin } = args;
  requireUnlocked(userId);
  let kr = await fetchKeyring();
  assertRotationServer(kr);
  const o = await openKeyring(userId, currentPin, kr);
  kr = o.kr; // keyring riletto da openKeyring dopo un 409 staleRev
  assertRotationServer(kr);
  await assertEpochInMemory(kr, o);
  const kdf = plainKdf(DEFAULT_KDF);
  const newSalt = rnd(16);
  let newS: Uint8Array | null = null;
  let authKey: Uint8Array | null = null;
  try {
    newS = await deriveS(newPin, newSalt, kdf);
    authKey = await deriveAuthKey(newS, userId);
    const S = newS;
    const authB64 = b64uEncode(authKey);
    const buildWrap = async () => {
      const kek = await deriveKekPin(S, o.serverShare, newSalt, userId);
      const wrappedVkPin = await wrapVkPin(kek, o.vkRaw, userId, kr.epoch, kdf);
      const wrapB64 = b64uEncode(wrappedVkPin);
      return {
        wrapB64,
        hash: await sha256hexBytes(wrappedVkPin),
        wrap: { kdf: 'argon2id', kdfParams: vaultKdf(kdf), pinSalt: b64uEncode(newSalt), wrappedVkPin: wrapB64, authKey: authB64 },
      };
    };
    let { wrapB64, hash, wrap } = await buildWrap();
    const offline = store().byUser[userId]?.offlineUnlock ?? false;
    const apply = (rev: number) => store().setKeyringCache(userId, {
      status: 'READY', epoch: kr.epoch, rev, kdf: 'argon2id', kdfParams: kdf, pinSalt: wrap.pinSalt,
      wrappedVkPin: wrapB64, rootKeyId: kr.rootKeyId!, offlineUnlock: offline,
    });

    let rev = kr.rev;
    for (let attempt = 0; ; attempt++) {
      const payload = JSON.stringify({ rev, wrap }); // firmato solo in memoria
      const proof = await signVkProof(o.sigKey, userId, kr.epoch, rev, payload);
      await device.setPending(userId, { kind: 'pin', rev, epoch: kr.epoch, wrappedVkPinHash: hash });
      try {
        const res = await vaultApi.updateKeyring<{ rev: number }>(payload, b64uEncode(proof));
        apply(res?.rev ?? rev + 1);
        await device.clearPinMarkerIf(userId, hash);
        return;
      } catch (e) {
        if (isApiError(e) && e.status === 409) {
          const fresh = await fetchKeyring();
          if (fresh.status === 'READY' && fresh.wrappedVkPin && (await wrappedHash(fresh.wrappedVkPin)) === hash) {
            apply(fresh.rev); // il PUT era gia' passato
            await device.clearPinMarkerIf(userId, hash);
            return;
          }
          if (attempt === 0 && fresh.status === 'READY') {
            if (fresh.epoch !== kr.epoch || fresh.wrappedVkPin !== kr.wrappedVkPin) {
              await device.clearPinMarkerIf(userId, hash).catch(() => {}); // nulla e' stato scritto
              throw new VaultSessionError('pinChangedElsewhere', 'errors.vault.pinChangedElsewhere');
            }
            kr = fresh;
            ({ wrapB64, hash, wrap } = await buildWrap());
            rev = fresh.rev;
            continue;
          }
        }
        if (isDefiniteReject(e)) await device.clearPinMarkerIf(userId, hash).catch(() => {});
        throw e;
      }
    }
  } finally {
    zero(o.vkRaw, o.serverShare, newS, authKey);
  }
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Pezzi della rotazione della VK (P4 fase 5), condivisi da `rotateVault` e dal recupero: VK nuova, sigKey nuova col suo wrap a epoch+1 e `prevVkWrap` (VK vecchia sotto la nuova).
 * Due sonde in memoria prima di restituire: `prev` si riapre e la VK sbustata e' proprio la vecchia (round-trip di un envelope all'epoch vecchio), la firma verifica con la pubblica.
 * Fallimento -> keyringInvalid (nulla e' stato inviato). Il chiamante azzera `vkNewRaw` e `sig.pkcs8`; in caso di errore li azzera la funzione stessa.
 */
export async function rotationParts(vkOldRaw: Uint8Array, vkOld: VaultKey, userId: string, epochOld: number) {
  const epochNew = epochOld + 1;
  const vkNewRaw = generateVkRaw();
  let pkcs8: Uint8Array | null = null;
  try {
    const vkNew = await importVk(vkNewRaw);
    const sig = await generateSigKey();
    pkcs8 = sig.pkcs8;
    const wrappedVkSigKey = await wrapVkSigKey(vkNew, pkcs8, userId, epochNew);
    const prevVkWrap = await wrapPrevVk(vkNew, vkOldRaw, userId, epochNew, epochOld);
    const bad = () => new VaultSessionError('keyringInvalid', 'errors.common.unknownError');
    try {
      const prevCheck = await unwrapPrevVk(vkNew, prevVkWrap, userId, epochNew, epochOld);
      const ctx = { userId, noteId: 'rotation-check', noteType: 'NOTE', epoch: epochOld };
      const env = await encryptItem(await deriveNoteKey(prevCheck, ctx.noteId), ctx, { t: '', c: 'x' }); // la VK sbustata e' proprio quella vecchia
      if ((await decryptItem(await deriveNoteKey(vkOld, ctx.noteId), ctx, env)).c !== 'x') throw bad();
      const sigCheck = await unwrapVkSigKey(vkNew, wrappedVkSigKey, userId, epochNew);
      const probe = new Uint8Array([1, 2, 3]);
      const ecdsa = { name: 'ECDSA', hash: 'SHA-256' } as const;
      const pub = await crypto.subtle.importKey('spki', sig.spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!(await crypto.subtle.verify(ecdsa, pub, await crypto.subtle.sign(ecdsa, sigCheck, probe), probe))) throw bad();
    } catch {
      throw bad();
    }
    return { vkNewRaw, vkNew, sig, wrappedVkSigKey, prevVkWrap };
  } catch (e) {
    zero(vkNewRaw, pkcs8);
    throw e;
  }
}


/**
 * Rotazione della VK (P4 fase 5, ogni nuovo Kit ruota; vault sbloccato + PIN riconfermato). PUT PRIMA, cerimonia dopo: il Kit nuovo si restituisce solo
 * dopo 200 (o 409 con escrowHash uguale). Nuovi: VK, sigKey, serverShare, salt (seconda Argon2 col PIN invariato), escrow; `prevVkWrap` = VK vecchia sotto la nuova.
 * Con `staleCount > 0` (note ancora all'epoch precedente) non scrive nulla: `rotationPending`, il chiamante finisce prima la rotazione in corso.
 * Su successo lo store passa a epoch+1 con `keys.prev` = VK vecchia (serve a finishRotation); il chiamante poi mostra il Kit, confirmKit, finishRotation.
 * 409 con hash diverso -> `kitNotUpdated` (store invariato).
 */
export async function rotateVault(args: { userId: string; pin: string; rootKey: RootKeyInfo }): Promise<{ kit: Uint8Array; escrowHash: string }> {
  const { userId, pin, rootKey } = args;
  requireUnlocked(userId);
  const keys0 = store().keys; // la sessione che ruota: se cambia durante le Argon2 (lock) il commit non la risblocca
  const pendingErr = () => new VaultSessionError('rotationPending', 'errors.vault.rotationPending');
  let kr = await fetchKeyring();
  assertRotationServer(kr);
  // Epoch diversa da quella in memoria (rotazione fatta altrove): vince sul resto, prima di staleCount/rotationPending e di ogni tentativo di PIN.
  if (kr.status === 'READY' && kr.epoch !== store().epoch) {
    await store().lockVault();
    throw new VaultSessionError('epochChanged', 'errors.vault.epochChanged');
  }
  if ((kr.staleCount ?? 0) > 0) throw pendingErr(); // prima di spendere un tentativo di PIN
  const o = await openKeyring(userId, pin, kr);
  kr = o.kr;
  assertRotationServer(kr);
  await assertEpochInMemory(kr, o);
  const epochOld = kr.epoch;
  const epochNew = epochOld + 1;
  const kdf = plainKdf(DEFAULT_KDF);
  const newSalt = rnd(16);
  const newShare = rnd(32);
  const sRoot = rnd(32);
  const sUser = rnd(20);
  let vkNewHeld: Uint8Array | null = null; // azzerata nel finally
  let S: Uint8Array | null = null;
  let authKey: Uint8Array | null = null;
  let pkcs8: Uint8Array | null = null;
  try {
    if ((kr.staleCount ?? 0) > 0) throw pendingErr(); // keyring riletto da openKeyring
    if ((o.prev || keys0?.prev) && (await hasForeignEpochPending(userId, epochOld))) throw new VaultSessionError('localPending', 'errors.vault.localPending');
    S = await deriveS(pin, newSalt, kdf);
    authKey = await deriveAuthKey(S, userId);
    const kek = await deriveKekPin(S, newShare, newSalt, userId);
    const parts = await rotationParts(o.vkRaw, o.vk, userId, epochOld); // VK nuova, sigKey nuova, prevVkWrap e le loro sonde
    const { vkNewRaw, vkNew, sig, wrappedVkSigKey, prevVkWrap } = parts;
    vkNewHeld = vkNewRaw;
    pkcs8 = sig.pkcs8;
    const wrappedVkPin = await wrapVkPin(kek, vkNewRaw, userId, epochNew, kdf);
    const rk = await deriveRk(sRoot, sUser, userId);
    const escrowBlob = await wrapEscrow(rk, vkNewRaw, userId, epochNew, rootKey.id);
    const sealedRootShare = await sealRootShare(sRoot, rootKey.ecdhSpki, userId, epochNew, rootKey.id);
    const userShareUnderVk = await wrapUserShare(vkNew, sUser, userId, epochNew);

    const bad = () => new VaultSessionError('keyringInvalid', 'errors.common.unknownError');
    // round-trip in memoria PRIMA della PUT (le sonde di prev e firma sono in rotationParts): un wrap che non si riapre dopo il commit sarebbe un vault perso
    const viaPin = await unwrapVkPin(kek, wrappedVkPin, userId, epochNew, kdf);
    const viaEscrow = await unwrapEscrow(rk, escrowBlob, userId, epochNew, rootKey.id);
    try {
      if (!sameBytes(viaPin, vkNewRaw) || !sameBytes(viaEscrow, vkNewRaw)) throw bad();
    } finally {
      zero(viaPin, viaEscrow);
    }

    const body: vaultApi.KeyringUpdatePayload = {
      rev: kr.rev,
      wrap: { kdf: 'argon2id', kdfParams: vaultKdf(kdf), pinSalt: b64uEncode(newSalt), wrappedVkPin: b64uEncode(wrappedVkPin), authKey: b64uEncode(authKey), serverShare: b64uEncode(newShare) },
      escrow: { escrowBlob: b64uEncode(escrowBlob), sealedRootShare: b64uEncode(sealedRootShare), rootKeyId: rootKey.id, userShareUnderVk: b64uEncode(userShareUnderVk) },
      rotate: { vkSigPub: b64uEncode(sig.spki), wrappedVkSigKey: b64uEncode(wrappedVkSigKey), prevVkWrap: b64uEncode(prevVkWrap) },
    };
    const payload = JSON.stringify(body);
    const proof = await signVkProof(o.sigKey, userId, epochOld, kr.rev, payload); // sigKey e epoch VECCHIE
    const escrowHash = await sha256hexBytes(escrowBlob);
    // marker di QUESTO escrow, costruito sul keyring (epoch, rev) appena letto: il resolver lo cancella solo quando il keyring lo ha superato
    await device.addKitMarker(userId, { kind: 'kit', escrowHash, epoch: epochOld, rev: kr.rev, origin: 'regenerate' });
    const offline = store().byUser[userId]?.offlineUnlock ?? false;

    // Commit locale (200 o 409 col nostro hash): cache, share, store a epoch+1 con la VK vecchia in `prev`. Con `fresh` la cache viene dal server.
    const commit = async (rev: number, fresh?: KeyringDto) => {
      if (fresh && fresh.epoch === epochNew) cacheKeyring(userId, fresh, offline); // il nostro hash E l'epoch attesa
      else if (fresh) cacheUnverified(userId, fresh, offline);
      else {
        store().setKeyringCache(userId, {
          status: 'READY', epoch: epochNew, rev, kdf: 'argon2id', kdfParams: kdf, pinSalt: b64uEncode(newSalt),
          wrappedVkPin: b64uEncode(wrappedVkPin), rootKeyId: rootKey.id, offlineUnlock: offline,
        });
      }
      // Subito dopo la cache e prima di ogni await: un refreshKeyringCache concorrente vedrebbe un'epoch piu' alta di quella in memoria e bloccherebbe.
      // Vault bloccato (o ri-sbloccato) nel frattempo: il server ha gia' committato, quindi niente unlock, ma cache, share e Kit restano.
      if (store().keys === keys0) {
        store().unlock(userId, { vkHkdf: vkNew.hkdf, vkAes: vkNew.aes, sigKey: sig.privateKey, prev: { epoch: epochOld, vkHkdf: o.vk.hkdf, vkAes: o.vk.aes } }, epochNew);
      } else if (store().epoch === epochOld) {
        // ri-sbloccato nel frattempo con le chiavi dell'epoch vecchio: il server e' a epochNew, la sessione sarebbe incoerente
        await store().lockVault();
      }
      if (offline) await saveDeviceShare(userId, newShare, epochNew, wrappedVkSigKey);
      else await device.deleteShare(userId).catch(() => {});
      await purgeApiCache();
    };

    try {
      rotating = true; // azzerato nel finally esterno
      const res = await vaultApi.updateKeyring(payload, b64uEncode(proof));
      if (res.epoch !== epochNew) throw bad(); // il server non ha ruotato come chiesto: esito ambiguo, il marker resta
      await commit(res.rev);
      return { kit: sUser, escrowHash };
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        const fresh = await fetchKeyring();
        if (fresh.status === 'READY' && fresh.escrowHash === escrowHash) {
          await commit(fresh.rev, fresh);
          return { kit: sUser, escrowHash };
        }
        await device.deleteKitMarker(userId, escrowHash).catch(() => {});
        if (e.key === 'errors.vault.recoveryInProgress') throw new VaultSessionError('recoveryInProgress', e.key);
        if (e.key === 'errors.vault.rotationPending') throw pendingErr();
        throw new VaultSessionError('kitNotUpdated', 'errors.vault.kitNotUpdated');
      }
      if (isDefiniteReject(e)) await device.deleteKitMarker(userId, escrowHash).catch(() => {});
      throw e;
    }
  } catch (e) {
    zero(sUser); // sUser e' del chiamante solo se tutto e' andato a buon fine
    throw e;
  } finally {
    rotating = false;
    zero(o.vkRaw, o.serverShare, S, authKey, pkcs8, vkNewHeld, newShare, sRoot);
  }
}

// ---------------------------------------------------------------- marker al riavvio

export type PendingOutcome = 'none' | 'kitUnconfirmed' | 'pinApplied' | 'pinNotApplied' | 'unknown';

const inFlight = new Map<string, Promise<PendingOutcome>>();

/**
 * Al riavvio con marker: UNA GET /keyring e una tabella di azioni, senza Web Lock (nessun flusso tocca il marker di un altro, quindi non serve).
 * Marker `kit` (uno per escrow): hash uguale al keyring -> 'kitUnconfirmed' (banner; il Kit NON si ri-mostra, il marker resta finche' non si rigenera e conferma);
 * hash diverso -> si cancella SOLO quando il keyring ha superato il suo (epoch, rev): da li' il server non puo' piu' committare quella richiesta
 * (PUT /keyring e complete fanno il CAS su rev). Setup (rev null): epoch diversa o status non NONE. Stesso rev: resta (puo' essere in volo), senza banner.
 * Slot legacy P2: come prima (uguale -> banner, diverso -> cancellato). Marker pin: hash uguale -> pinApplied; diverso -> pinNotApplied solo se (epoch, rev) del keyring hanno superato il marker, altrimenti resta (PUT forse in volo); compare-and-delete per hash, false (lo ha risolto un'altra scheda) -> 'none'.
 * 'kitUnconfirmed' vince sul pin. GET fallita -> 'unknown' e nulla si tocca.
 * Dedupe nella scheda: due chiamate concorrenti (StrictMode, effect doppi) condividono la promise in volo, tolta al settle.
 */
export function checkPendingOnStart(userId: string): Promise<PendingOutcome> {
  const cur = inFlight.get(userId);
  if (cur) return cur;
  const p = checkPending(userId).finally(() => { if (inFlight.get(userId) === p) inFlight.delete(userId); });
  inFlight.set(userId, p);
  return p;
}

async function checkPending(userId: string): Promise<PendingOutcome> {
  let kits: device.KitMarker[] = [];
  let legacy: device.KitMarker | null = null;
  let pin: device.PinMarker | null = null;
  try { [kits, legacy, pin] = await Promise.all([device.listKitMarkers(userId), device.getLegacyKitMarker(userId), device.getPending(userId, 'pin')]); } catch { return 'none'; }
  if (!kits.length && !legacy && !pin) return 'none';
  if (!isCurrent(userId)) return 'unknown';
  let kr: KeyringDto;
  try { kr = await fetchKeyring(); } catch { return 'unknown'; }
  if (!isCurrent(userId)) return 'unknown'; // risposta del token di un altro utente: ne' scritture ne' cancellazioni

  let unconfirmed = false;
  for (const m of kits) {
    if (kr.escrowHash && kr.escrowHash === m.escrowHash) { unconfirmed = true; continue; }
    const superseded = m.rev === null ? kr.epoch !== m.epoch || kr.status !== 'NONE' : kr.epoch !== m.epoch || kr.rev > m.rev;
    if (superseded) await device.deleteKitMarker(userId, m.escrowHash).catch(() => {});
  }
  if (legacy) {
    if (kr.escrowHash && kr.escrowHash === legacy.escrowHash) unconfirmed = true;
    else await device.deleteLegacyKitMarkerIf(userId, legacy.escrowHash).catch(() => {});
  }

  let outcome: PendingOutcome = 'none';
  if (pin) {
    const applied = kr.status === 'READY' && !!kr.wrappedVkPin && (await wrappedHash(kr.wrappedVkPin)) === pin.wrappedVkPinHash;
    // il wrap e' il NOSTRO (hash del marker) all'epoch del marker: scrittura sicura; altrimenti il keyring e' di altri e l'epoch non puo' salire
    if (kr.status === 'READY') (applied && (pin.epoch === undefined || kr.epoch === pin.epoch) ? cacheKeyring : cacheUnverified)(userId, kr, store().byUser[userId]?.offlineUnlock ?? false);
    // hash diverso: come per il kit, "non applicato" solo se il keyring ha superato il marker (epoch o rev); a parita' di rev il PUT puo' essere ancora in volo in un'altra scheda
    const superseded = (pin.epoch !== undefined && kr.epoch !== pin.epoch) || kr.rev > pin.rev; // solo (epoch, rev), come per il kit: lo status non decide
    if ((applied || superseded) && await device.clearPinMarkerIf(userId, pin.wrappedVkPinHash)) outcome = applied ? 'pinApplied' : 'pinNotApplied';
  }
  return unconfirmed ? 'kitUnconfirmed' : outcome;
}

// ---------------------------------------------------------------- cambio utente senza logout

// Backlog T11: se l'utente autenticato cambia (setAuth senza logout), le chiavi del precedente non restano.
// La subscribe vale solo per questa scheda: le altre schede passano dall'evento "storage" sulla chiave persistita di authStore.
useAuthStore.subscribe((s) => {
  const { unlockedUserId, lockVault } = useVaultStore.getState();
  if (unlockedUserId && s.user?.id !== unlockedUserId) void lockVault();
});

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (ev.key !== 'auth-storage') return;
    const { unlockedUserId, lockVault } = useVaultStore.getState();
    if (!unlockedUserId) return;
    let id: unknown;
    try { id = (JSON.parse(ev.newValue ?? 'null') as { state?: { user?: { id?: unknown } } } | null)?.state?.user?.id; } catch { return; }
    if (id !== unlockedUserId) void lockVault(); // altra scheda: utente diverso, o logout (newValue assente)
  });
}
