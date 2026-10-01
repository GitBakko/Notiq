import { encryptContent, decryptContent } from '../../utils/crypto';
import { useVaultStore } from '../../store/vaultStore';

export interface CredentialData {
  siteUrl: string;
  username: string;
  password: string;
  notes: string;
  faviconUrl?: string;
  screenshotBase64?: string;
}

export const EMPTY_CREDENTIAL: CredentialData = {
  siteUrl: '',
  username: '',
  password: '',
  notes: '',
  faviconUrl: undefined,
  screenshotBase64: undefined,
};

// Decrypt cache (pin + ciphertext -> plaintext): avoids repeated slow decrypts while the vault
// is unlocked. Cleared on lock. Values are cloned in/out so callers can't mutate cached entries.
const decryptCache = new Map<string, CredentialData>();
const cacheKey = (ciphertext: string, pin: string) => pin + '\0' + ciphertext;

// optional call: some tests mock the store without subscribe()
useVaultStore.subscribe?.((s) => {
  if (!s.isUnlocked) decryptCache.clear();
});

const MAX_CACHE = 200;

// Cache only while the vault is unlocked with this very pin (the lock handler clears the map).
function cachePut(ciphertext: string, pin: string, data: CredentialData) {
  const s = useVaultStore.getState?.();
  if (!s?.isUnlocked || s.pin !== pin) return;
  if (decryptCache.size >= MAX_CACHE) decryptCache.delete(decryptCache.keys().next().value as string);
  decryptCache.set(cacheKey(ciphertext, pin), structuredClone(data));
}

/** test-only */
export const __decryptCacheSize = () => decryptCache.size;

export function encryptCredential(data: CredentialData, pin: string): string {
  const ciphertext = encryptContent(JSON.stringify(data), pin);
  cachePut(ciphertext, pin, data);
  return ciphertext;
}

export function decryptCredential(ciphertext: string, pin: string): CredentialData | null {
  const key = cacheKey(ciphertext, pin);
  const hit = decryptCache.get(key);
  if (hit) return structuredClone(hit);
  const json = decryptContent(ciphertext, pin);
  if (!json) return null;
  try {
    const data = JSON.parse(json) as CredentialData;
    cachePut(ciphertext, pin, data);
    return data;
  } catch {
    return null;
  }
}

/** Extracts the hostname from a URL for display in the list */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** Checks if a stored URL is a valid absolute URL (filters out malformed relative URLs) */
export function isValidAbsoluteUrl(url?: string): boolean {
  if (!url) return false;
  if (url.startsWith('data:')) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
