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
  constructor(status: number, key: string, kind: VaultErrorKind) {
    super(key);
    this.name = 'VaultApiError';
    this.status = status;
    this.key = key;
    this.kind = kind;
  }
}

function toVaultError(err: unknown): VaultApiError {
  if (err instanceof VaultApiError) return err;
  if (!isAxiosError(err) || !err.response) return new VaultApiError(0, 'errors.common.networkError', 'network');
  const { status, data } = err.response;
  const kind = KIND_BY_STATUS[status] ?? 'unknown';
  const msg = (data as { message?: unknown } | undefined)?.message;
  const key = typeof msg === 'string' && msg.startsWith('errors.') ? msg : (FALLBACK_KEY[kind] ?? 'errors.common.unknownError');
  return new VaultApiError(status, key, kind);
}

const MIGRATE_TIMEOUT_MS = 120000;
const RETRY_DEFAULT_MS = 1000;
const RETRY_MAX_MS = 5000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function retryDelay(err: unknown): number {
  const h = isAxiosError(err) ? Number(err.response?.headers?.['retry-after']) : NaN;
  return Number.isFinite(h) && h > 0 ? Math.min(h * 1000, RETRY_MAX_MS) : RETRY_DEFAULT_MS;
}

async function call<T>(method: 'get' | 'post' | 'put', url: string, body?: unknown, retryOn429 = false, timeout?: number): Promise<T> {
  const run = async (): Promise<T> => {
    const res = await api.request<T>({ method, url, data: body, ...(timeout ? { timeout } : {}) });
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

export interface MigrateItem {
  id: string;
  baseHash: string;
  content: string;
  noteType: 'NOTE' | 'CREDENTIAL';
}

// Forma delle risposte definita dal service backend: i chiamanti (vaultSession) le restringono.
export async function getKeyring<T = unknown>(): Promise<T> {
  try {
    return await call<T>('get', '/vault/keyring');
  } finally {
    await purgeVaultCache();
  }
}

export const createKeyring = <T = unknown>(body: CreateKeyringBody) => call<T>('post', '/vault/keyring', body);

export const unlock = (authKey: string) => call<{ serverShare: string }>('post', '/vault/unlock', { authKey });

export const updateKeyring = <T = unknown>(payload: string, vkProof: string) =>
  call<T>('put', '/vault/keyring', { payload, vkProof });

export const getItems = <T = unknown>(body: VaultItemsBody = {}) => call<T>('post', '/vault/items', body, true);

export const migrateItems = <T = unknown>(items: MigrateItem[]) => call<T>('post', '/vault/migrate', { items }, true, MIGRATE_TIMEOUT_MS);

export const finalizeItems = <T = unknown>(ids: string[]) => call<T>('post', '/vault/finalize', { ids });
