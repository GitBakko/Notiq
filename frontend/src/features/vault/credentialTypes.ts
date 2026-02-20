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

export function encryptCredential(data: CredentialData, pin: string): string {
  return encryptContent(JSON.stringify(data), pin);
}

export function decryptCredential(ciphertext: string, pin: string): CredentialData | null {
  const json = decryptContent(ciphertext, pin);
  if (!json) return null;
  try {
    return JSON.parse(json);
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
