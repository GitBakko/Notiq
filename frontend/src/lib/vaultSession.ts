// Vault v3: flussi di sessione del piano P2 §5.4 (setup, sblocco online/offline, cambio PIN, Kit, interruttore offline).
// Nessuna UI. I byte grezzi (VK, S, pkcs8, S_root, serverShare) vivono solo dentro le funzioni e si azzerano con fill(0).
// Il Kit (S_user, 20 B) lo restituiscono solo setup e regenerateKit DOPO la risposta 2xx del server: chi lo mostra lo
// tiene nello stato del componente e fa fill(0) a fine cerimonia, poi chiama confirmKit.
import * as vaultApi from './vaultApi';
import type { OpenRecovery, VaultApiError } from './vaultApi';
import { purgeApiCache } from './apiCache';
import * as device from './deviceKeyStore';
import { useVaultStore, type VaultKeys } from '../store/vaultStore';
import { useAuthStore } from '../store/authStore';
import { DEFAULT_KDF, deriveS, type KdfParams } from '../utils/argon2';
import {
  b64uDecode, b64uEncode, decryptShare, deriveAuthKey, deriveKekPin, deriveRk, encryptShare, generateSigKey, generateVkRaw,
  importVk, sealRootShare, sha256hexBytes, signVkProof, unwrapVkPin, unwrapVkSigKey, wrapEscrow, wrapUserShare, wrapVkPin,
  wrapVkSigKey, type VaultKey,
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
}

export type VaultSessionCode =
  | 'wrongPin' // 403 allo sblocco, o tag GCM offline
  | 'pinLocked' // 429 o lockedUntil nel futuro
  | 'notReady'
  | 'vaultLocked' // operazione che richiede il vault sbloccato
  | 'offlineUnavailable'
  | 'kitNotUpdated'
  | 'recoveryInProgress' // 409 con recupero aperto (fino a 7 giorni): il Kit si rigenera dopo
  | 'pinChangedElsewhere' // changePin al 409: il wrap e' cambiato altrove (recupero o altro cambio PIN), niente da rimandare
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
 * il vecchio PIN continuerebbe a sbloccare offline. Solo avanti (epoch/rev maggiori): una GET partita prima di un cambio
 * PIN locale non riporta indietro la cache. Senza cache o con keyring non READY/incompleto non fa nulla.
 * Limite intrinseco: un dispositivo sempre offline non vede il cambio.
 */
export function syncKeyringCache(userId: string, kr: KeyringDto): void {
  const c = store().byUser[userId];
  if (!c || kr.status !== 'READY') return;
  if (!(kr.epoch > c.epoch || (kr.epoch === c.epoch && kr.rev > c.rev))) return;
  try { cacheKeyring(userId, kr, c.offlineUnlock); } catch { /* keyring incompleto: cache invariata */ }
}

/** GET del keyring + `syncKeyringCache`; errori di rete o server ignorati (best effort). */
export async function refreshKeyringCache(userId: string): Promise<void> {
  try { syncKeyringCache(userId, await fetchKeyring()); } catch { /* offline o server giu': cache invariata */ }
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
  vkRaw: Uint8Array;
  vk: VaultKey;
  sigKey: CryptoKey;
  serverShare: Uint8Array;
  wrappedSig: Uint8Array;
}

/** Sblocco online fino a VK/sigKey. Il chiamante azzera vkRaw e serverShare. */
async function openKeyring(userId: string, pin: string, kr: KeyringDto): Promise<Opened> {
  if (kr.status !== 'READY') throw new VaultSessionError('notReady', 'errors.vault.notReady');
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
      res = await vaultApi.unlock(b64uEncode(authKey));
    } finally {
      zero(authKey);
    }
    serverShare = b64uDecode(res.serverShare);
    const kek = await deriveKekPin(S, serverShare, salt, userId);
    vkRaw = await unwrapVkPin(kek, b64uDecode(kr.wrappedVkPin), userId, epoch, params);
    const vk = await importVk(vkRaw);
    const wrappedSig = b64uDecode(kr.wrappedVkSigKey);
    const sigKey = await unwrapVkSigKey(vk, wrappedSig, userId, epoch);
    return { vkRaw, vk, sigKey, serverShare, wrappedSig };
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
        try { const fresh = await fetchKeyring(); if (fresh.status === 'READY') cacheKeyring(userId, fresh, store().byUser[userId]?.offlineUnlock ?? false); } catch { /* cache invariata */ }
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
    cacheKeyring(userId, kr0, store().byUser[userId]?.offlineUnlock ?? false);
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
          try { if (fresh?.status === 'READY') cacheKeyring(userId, fresh, false); } catch { /* ignora */ }
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
  cacheKeyring(userId, kr, offline);
  const o = await openKeyring(userId, pin, kr);
  try {
    let offlineSaved = true;
    if (offline) offlineSaved = await saveDeviceShare(userId, o.serverShare, kr.epoch, o.wrappedSig);
    else await device.deleteShare(userId).catch(() => {}); // OFF: nessuno share residuo
    store().unlock(userId, { vkHkdf: o.vk.hkdf, vkAes: o.vk.aes, sigKey: o.sigKey }, kr.epoch);
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
export async function removeFromDevice(userId: string): Promise<void> {
  store().forgetUser(userId);
  await device.removeDevice(userId);
}

// ---------------------------------------------------------------- cambio PIN, Kit

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
  const o = await openKeyring(userId, currentPin, kr);
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

/**
 * Rigenerazione del Kit (vault sbloccato + PIN riconfermato). PUT PRIMA, cerimonia dopo: il Kit nuovo si restituisce solo
 * dopo 200 (o 409 con escrowHash uguale). 409 con hash diverso -> `kitNotUpdated`.
 */
export async function regenerateKit(args: { userId: string; pin: string; rootKey: RootKeyInfo }): Promise<{ kit: Uint8Array; escrowHash: string }> {
  const { userId, pin, rootKey } = args;
  requireUnlocked(userId);
  const kr = await fetchKeyring();
  const o = await openKeyring(userId, pin, kr);
  const sRoot = rnd(32);
  const sUser = rnd(20);
  try {
    const rk = await deriveRk(sRoot, sUser, userId);
    const escrowBlob = await wrapEscrow(rk, o.vkRaw, userId, kr.epoch, rootKey.id);
    const sealedRootShare = await sealRootShare(sRoot, rootKey.ecdhSpki, userId, kr.epoch, rootKey.id);
    const userShareUnderVk = await wrapUserShare(o.vk, sUser, userId, kr.epoch);
    const payload = JSON.stringify({
      rev: kr.rev,
      escrow: {
        escrowBlob: b64uEncode(escrowBlob),
        sealedRootShare: b64uEncode(sealedRootShare),
        rootKeyId: rootKey.id,
        userShareUnderVk: b64uEncode(userShareUnderVk),
      },
    });
    const proof = await signVkProof(o.sigKey, userId, kr.epoch, kr.rev, payload);
    const escrowHash = await sha256hexBytes(escrowBlob);
    // marker di QUESTO escrow, costruito sul keyring (epoch, rev) appena letto: il resolver lo cancella solo quando il keyring lo ha superato
    await device.addKitMarker(userId, { kind: 'kit', escrowHash, epoch: kr.epoch, rev: kr.rev, origin: 'regenerate' });
    const offline = store().byUser[userId]?.offlineUnlock ?? false;
    try {
      const res = await vaultApi.updateKeyring<{ rev: number }>(payload, b64uEncode(proof));
      store().setKeyringCache(userId, {
        status: 'READY', epoch: kr.epoch, rev: res?.rev ?? kr.rev + 1, kdf: kr.kdf ?? 'argon2id', kdfParams: kr.kdfParams!,
        pinSalt: kr.pinSalt!, wrappedVkPin: kr.wrappedVkPin!, rootKeyId: rootKey.id, offlineUnlock: offline,
      });
      return { kit: sUser, escrowHash };
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        const fresh = await fetchKeyring();
        if (fresh.status === 'READY' && fresh.escrowHash === escrowHash) {
          cacheKeyring(userId, fresh, offline);
          return { kit: sUser, escrowHash };
        }
        await device.deleteKitMarker(userId, escrowHash).catch(() => {});
        if (e.key === 'errors.vault.recoveryInProgress') throw new VaultSessionError('recoveryInProgress', e.key);
        throw new VaultSessionError('kitNotUpdated', 'errors.vault.kitNotUpdated');
      }
      if (isDefiniteReject(e)) await device.deleteKitMarker(userId, escrowHash).catch(() => {});
      throw e;
    }
  } catch (e) {
    zero(sUser); // sUser e' del chiamante solo se tutto e' andato a buon fine
    throw e;
  } finally {
    zero(o.vkRaw, o.serverShare, sRoot);
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
    if (kr.status === 'READY') cacheKeyring(userId, kr, store().byUser[userId]?.offlineUnlock ?? false);
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
