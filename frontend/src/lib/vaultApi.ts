import { isAxiosError } from 'axios';
import api from './api';
import { purgeVaultCache } from './apiCache';

// Client delle 7 route /api/vault/*. Le risposte non vanno MAI in cache applicative (TanStack Query, Dexie):
// l'unica cache che puo' toccarle e' il runtimeCaching Workbox 'api-cache' (solo GET), ripulita da purgeVaultCache() (apiCache.ts).

export type VaultErrorKind =
  | 'invalid' // 400
  | 'forbidden' // 403
  | 'conflict' // 409
  | 'rejected' // 422
  | 'rateLimited' // 429
  | 'unavailable' // 503
  | 'unauthorized' // 401: non atteso (l'interceptor di api.ts gestisce il refresh)
  | 'network'
  | 'unknown';

const KIND_BY_STATUS: Record<number, VaultErrorKind> = {
  400: 'invalid',
  413: 'invalid',
  415: 'invalid',
  401: 'unauthorized',
  403: 'forbidden',
  409: 'conflict',
  422: 'rejected',
  429: 'rateLimited',
  503: 'unavailable',
};

const FALLBACK_KEY: Partial<Record<VaultErrorKind, string>> = {
  invalid: 'errors.vault.invalidPayload',
  unavailable: 'errors.vault.unavailable',
  rateLimited: 'errors.vault.rateLimited',
};

export class VaultApiError extends Error {
  status: number;
  key: string;
  kind: VaultErrorKind;
  /** Vero se il body ha un `message` errors.*: la risposta viene dal vault, non da un proxy o da un layer intermedio (un 503 senza e' ambiguo). */
  fromServer: boolean;
  constructor(status: number, key: string, kind: VaultErrorKind, fromServer = false) {
    super(key);
    this.name = 'VaultApiError';
    this.status = status;
    this.key = key;
    this.kind = kind;
    this.fromServer = fromServer;
  }
}

function toVaultError(err: unknown): VaultApiError {
  if (err instanceof VaultApiError) return err;
  if (!isAxiosError(err) || !err.response) return new VaultApiError(0, 'errors.common.networkError', 'network');
  const { status, data } = err.response;
  const kind = KIND_BY_STATUS[status] ?? 'unknown';
  const msg = (data as { message?: unknown } | undefined)?.message;
  const fromServer = typeof msg === 'string' && msg.startsWith('errors.');
  const key = fromServer ? msg : (FALLBACK_KEY[kind] ?? 'errors.common.unknownError');
  return new VaultApiError(status, key, kind, fromServer);
}

const MIGRATE_TIMEOUT_MS = 120000;
const RETRY_DEFAULT_MS = 1000;
const RETRY_MAX_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryDelay(err: unknown): number {
  const h = isAxiosError(err) ? Number(err.response?.headers?.['retry-after']) : NaN;
  return Number.isFinite(h) && h > 0 ? Math.min(h * 1000, RETRY_MAX_MS) : RETRY_DEFAULT_MS;
}

// Forma minima delle risposte 2xx che i chiamanti leggono come fatti. Un 2xx con un body che non e' del vault (proxy, portale, errore IIS con 200)
// e' un esito ambiguo (errore di rete), mai un successo ne' un rifiuto: i campi mancanti non devono diventare "niente da fare".
const isObj = (d: unknown): d is Record<string, unknown> => !!d && typeof d === 'object' && !Array.isArray(d);
const isUint = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const KEYRING_STATUSES = ['NONE', 'READY', 'RESET_PENDING'];
const RECOVERY_STATUSES = ['PENDING_APPROVAL', 'PENDING_CODE', 'WAITING', 'RELEASED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'EXPIRED'];
const okKeyring = (d: unknown) => isObj(d) && KEYRING_STATUSES.includes(d.status as string) && isUint(d.epoch) && isUint(d.rev);
const okRecovery = (d: unknown) => isObj(d) && RECOVERY_STATUSES.includes(d.status as string);
const okCompleted = (d: unknown) => isObj(d) && d.status === 'COMPLETED';
const okRev = (d: unknown) => isObj(d) && isUint(d.rev);
const okCreated = (d: unknown) => isObj(d) && typeof d.id === 'string' && d.id !== '' && typeof d.fingerprint === 'string';

async function call<T>(method: 'get' | 'post' | 'put' | 'delete', url: string, body?: unknown, retryOn429 = false, timeout?: number, shape?: (d: unknown) => boolean): Promise<T> {
  const run = async (): Promise<T> => {
    const res = await api.request<T>({ method, url, data: body, ...(timeout ? { timeout } : {}) });
    if (shape && !shape(res.data)) throw new VaultApiError(0, 'errors.common.networkError', 'network');
    return res.data;
  };
  try {
    return await run();
  } catch (e) {
    if (retryOn429 && isAxiosError(e) && e.response?.status === 429) {
      await sleep(retryDelay(e));
      try {
        return await run();
      } catch (e2) {
        throw toVaultError(e2);
      }
    }
    throw toVaultError(e);
  }
}

/** Richiesta di recupero aperta dell'utente, come la restituisce GET /keyring (null: nessuna). */
export interface OpenRecovery {
  id: string;
  status: 'PENDING_APPROVAL' | 'PENDING_CODE' | 'WAITING' | 'RELEASED';
  fingerprint: string;
  createdAt: string;
  notBefore: string | null;
}

export interface VaultKdfParams {
  m: number;
  t: number;
  p: 1;
}

// POST /keyring: password in chiaro (verifica lato server), mai migrationState.
export interface CreateKeyringBody {
  expectedEpoch: number;
  password: string;
  kdf: 'argon2id';
  kdfParams: VaultKdfParams;
  pinSalt: string;
  wrappedVkPin: string;
  authKey: string;
  serverShare: string;
  vkSigPub: string;
  wrappedVkSigKey: string;
  escrowBlob: string;
  sealedRootShare: string;
  rootKeyId: string;
  userShareUnderVk: string;
}

export interface VaultItemsBody {
  ids?: string[];
  after?: string;
}

/** Extra of the `ids` answer. Not being in `items` does not mean absent (getItems filters isVault:true):
 *  `absent` = not a note of this user (an id of someone else is absent too), `notVault` = a note of the user that is not vault. */
export interface VaultIdsExtra {
  absent?: string[];
  notVault?: string[];
}

export interface MigrateItem {
  id: string;
  baseHash: string;
  content: string;
  noteType: 'NOTE' | 'CREDENTIAL';
}

// Forma delle risposte definita dal service backend: i chiamanti (vaultSession) le restringono.
export async function getKeyring<T = unknown>(): Promise<T> {
  try {
    return await call<T>('get', '/vault/keyring', undefined, false, undefined, okKeyring);
  } finally {
    await purgeVaultCache();
  }
}

export const createKeyring = <T = unknown>(body: CreateKeyringBody) => call<T>('post', '/vault/keyring', body, false, undefined, okRev);

export const unlock = (authKey: string) => call<{ serverShare: string }>('post', '/vault/unlock', { authKey });

export const updateKeyring = <T = unknown>(payload: string, vkProof: string) =>
  call<T>('put', '/vault/keyring', { payload, vkProof }, false, undefined, okRev);

export const getItems = <T = unknown>(body: VaultItemsBody = {}) => call<T>('post', '/vault/items', body, true);

export const migrateItems = <T = unknown>(items: MigrateItem[]) => call<T>('post', '/vault/migrate', { items }, true, MIGRATE_TIMEOUT_MS);

export const cancelRecovery = (id: string) => call<{ status: 'CANCELLED' }>('delete', `/vault/recovery/${encodeURIComponent(id)}`);

/** Stati di una richiesta di recupero come li restituisce GET /recovery/:id (EXPIRED anche per scadenza non ancora marcata dal job). */
export type RecoveryStatus = 'PENDING_APPROVAL' | 'PENDING_CODE' | 'WAITING' | 'RELEASED' | 'COMPLETED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export interface RecoveryDto {
  status: RecoveryStatus;
  fingerprint: string;
  notBefore: string | null;
  releaseExpiresAt: string | null;
  sealedCodeA: string | null;
  /** Solo in RELEASED non scaduta: busta (157 B), firma root (96 B) ed escrowBlob (60 B), tutti b64url. */
  rootShareForClient: string | null;
  rootSignature: string | null;
  escrowBlob: string | null;
}

export const createRecovery = (clientEphPub: string, reason?: string) =>
  call<{ id: string; fingerprint: string }>('post', '/vault/recovery', reason ? { clientEphPub, reason } : { clientEphPub }, false, undefined, okCreated);

export async function getRecovery(id: string): Promise<RecoveryDto> {
  try {
    return await call<RecoveryDto>('get', `/vault/recovery/${encodeURIComponent(id)}`, undefined, false, undefined, okRecovery);
  } finally {
    await purgeVaultCache();
  }
}

export const confirmRecovery = (id: string, codeA: string, codeB: string) =>
  call<{ status: 'WAITING'; notBefore: string }>('post', `/vault/recovery/${encodeURIComponent(id)}/confirm`, { codeA, codeB });

export const completeRecovery = (id: string, payload: string, vkProof: string) =>
  call<{ status: 'COMPLETED' }>('post', `/vault/recovery/${encodeURIComponent(id)}/complete`, { payload, vkProof }, false, undefined, okCompleted);

export const finalizeItems = <T = unknown>(ids: string[]) => call<T>('post', '/vault/finalize', { ids });
