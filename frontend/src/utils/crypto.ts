import CryptoJS from 'crypto-js';

const KDF_ITERATIONS = 100_000;
const SALT_SIZE = 16; // 16 bytes = 128 bits
const KEY_SIZE = 256 / 32; // 256-bit key (CryptoJS WordArray units = 32-bit words)
const IV_SIZE = 128 / 32; // 128-bit IV
const V2_PREFIX = 'v2:';

// Helper to hash the PIN for storage/verification
export const hashPin = (pin: string): string => {
  return CryptoJS.SHA256(pin).toString();
};

// Derive a 256-bit key from PIN + salt using PBKDF2
const deriveKey = (pin: string, salt: CryptoJS.lib.WordArray) => {
  return CryptoJS.PBKDF2(pin, salt, {
    keySize: KEY_SIZE + IV_SIZE,
    iterations: KDF_ITERATIONS,
    hasher: CryptoJS.algo.SHA256,
  });
};

// Encrypt content using the PIN with PBKDF2-derived key (v2 format)
export const encryptContent = (content: string, pin: string): string => {
  const salt = CryptoJS.lib.WordArray.random(SALT_SIZE);
  const derived = deriveKey(pin, salt);

  const key = CryptoJS.lib.WordArray.create(derived.words.slice(0, KEY_SIZE), KEY_SIZE * 4);
  const iv = CryptoJS.lib.WordArray.create(derived.words.slice(KEY_SIZE), IV_SIZE * 4);

  const encrypted = CryptoJS.AES.encrypt(content, key, { iv });
  const saltHex = salt.toString(CryptoJS.enc.Hex);

  return `${V2_PREFIX}${saltHex}:${encrypted.toString()}`;
};

// Decrypt content using the PIN
// Supports v2 (PBKDF2) format and legacy (passphrase) format for backward compatibility
// Returns null if decryption fails (wrong PIN)
export const decryptContent = (encryptedContent: string, pin: string): string | null => {
  try {
    if (encryptedContent.startsWith(V2_PREFIX)) {
      // v2 format: "v2:<salt_hex>:<ciphertext>"
      const withoutPrefix = encryptedContent.slice(V2_PREFIX.length);
      const colonIdx = withoutPrefix.indexOf(':');
      if (colonIdx === -1) return null;

      const saltHex = withoutPrefix.slice(0, colonIdx);
      const ciphertext = withoutPrefix.slice(colonIdx + 1);

      const salt = CryptoJS.enc.Hex.parse(saltHex);
      const derived = deriveKey(pin, salt);

      const key = CryptoJS.lib.WordArray.create(derived.words.slice(0, KEY_SIZE), KEY_SIZE * 4);
      const iv = CryptoJS.lib.WordArray.create(derived.words.slice(KEY_SIZE), IV_SIZE * 4);

      const bytes = CryptoJS.AES.decrypt(ciphertext, key, { iv });
      const originalText = bytes.toString(CryptoJS.enc.Utf8);
      if (!originalText) return null;
      return originalText;
    }

    // Legacy format: CryptoJS passphrase mode (PIN used directly)
    // [BACKUP] 2026-02-27 — legacy decryption kept for backward compatibility
    const bytes = CryptoJS.AES.decrypt(encryptedContent, pin);
    const originalText = bytes.toString(CryptoJS.enc.Utf8);
    if (!originalText) return null;
    return originalText;
  } catch {
    return null;
  }
};
