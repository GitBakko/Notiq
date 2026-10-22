import { encryptContent, decryptContent } from '../../utils/crypto';

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

/** @deprecated legacy pre-v3 (usato solo da VaultPage fino a T21). Le credenziali v3 sono envelope: vedi `vaultCodec`. */
export function encryptCredential(data: CredentialData, pin: string): string {
  return encryptContent(JSON.stringify(data), pin);
}

/**
 * Legacy pre-v3 (CryptoJS/v2 con PIN): serve alla migrazione (wizard T20), non dipende dallo store.
 * Nessuna cache: il plaintext non resta in memoria oltre la chiamata.
 */
export function decryptCredential(ciphertext: string, pin: string): CredentialData | null {
  const json = decryptContent(ciphertext, pin);
  return json ? parseCredential(json) : null;
}

/** `c` di un envelope CREDENTIAL: oggetto JSON, altrimenti null. */
export function parseCredential(c: string): CredentialData | null {
  try {
    const data: unknown = JSON.parse(c);
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as CredentialData) : null;
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
