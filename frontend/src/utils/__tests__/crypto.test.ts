import { describe, it, expect } from 'vitest';
import { hashPin, encryptContent, decryptContent } from '../crypto';

describe('hashPin', () => {
  it('produces a deterministic hash for the same input', () => {
    const hash1 = hashPin('1234');
    const hash2 = hashPin('1234');
    expect(hash1).toBe(hash2);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = hashPin('1234');
    const hash2 = hashPin('5678');
    expect(hash1).not.toBe(hash2);
  });

  it('returns a 64-character hex string (SHA-256)', () => {
    const hash = hashPin('1234');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles empty string input', () => {
    const hash = hashPin('');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles unicode input', () => {
    const hash = hashPin('\u{1F600}\u{1F680}');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('encryptContent / decryptContent roundtrip', () => {
  it('decrypts back to the original plaintext', () => {
    const pin = 'mySecretPin';
    const plaintext = 'Hello, World!';
    const encrypted = encryptContent(plaintext, pin);
    const decrypted = decryptContent(encrypted, pin);
    expect(decrypted).toBe(plaintext);
  });

  it('produces different ciphertext than the plaintext', () => {
    const pin = '1234';
    const plaintext = 'sensitive data';
    const encrypted = encryptContent(plaintext, pin);
    expect(encrypted).not.toBe(plaintext);
  });

  it('produces different ciphertext on each call (random IV)', () => {
    const pin = '1234';
    const plaintext = 'same content';
    const encrypted1 = encryptContent(plaintext, pin);
    const encrypted2 = encryptContent(plaintext, pin);
    // CryptoJS AES uses a random salt each time, so ciphertexts should differ
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('roundtrips empty content', () => {
    const pin = 'pin';
    const encrypted = encryptContent('', pin);
    const decrypted = decryptContent(encrypted, pin);
    // Empty string encrypts to something, but decrypting returns empty or null
    // CryptoJS AES with empty string: decrypt returns empty string which is falsy -> returns null
    expect(decrypted).toBeNull();
  });

  it('roundtrips unicode content', () => {
    const pin = 'secret';
    const plaintext = 'Ciao mondo! \u00E8\u00E0\u00F9\u00F2 \u{1F600}\u{1F680} \u4F60\u597D';
    const encrypted = encryptContent(plaintext, pin);
    const decrypted = decryptContent(encrypted, pin);
    expect(decrypted).toBe(plaintext);
  });

  it('roundtrips large content', () => {
    const pin = 'key123';
    const plaintext = 'A'.repeat(100_000);
    const encrypted = encryptContent(plaintext, pin);
    const decrypted = decryptContent(encrypted, pin);
    expect(decrypted).toBe(plaintext);
  });

  it('roundtrips content with special characters', () => {
    const pin = 'pin';
    const plaintext = '{"key": "value", "nested": {"arr": [1,2,3]}}\n\t<html>&amp;</html>';
    const encrypted = encryptContent(plaintext, pin);
    const decrypted = decryptContent(encrypted, pin);
    expect(decrypted).toBe(plaintext);
  });

  it('roundtrips multiline content', () => {
    const pin = 'pin';
    const plaintext = 'Line 1\nLine 2\nLine 3\n\nLine 5';
    const encrypted = encryptContent(plaintext, pin);
    const decrypted = decryptContent(encrypted, pin);
    expect(decrypted).toBe(plaintext);
  });
});

describe('decryptContent with wrong PIN', () => {
  it('returns null when decrypting with incorrect PIN', () => {
    const correctPin = 'correctPin';
    const wrongPin = 'wrongPin';
    const plaintext = 'secret message';
    const encrypted = encryptContent(plaintext, correctPin);
    const result = decryptContent(encrypted, wrongPin);
    expect(result).toBeNull();
  });

  it('returns null for invalid ciphertext', () => {
    const result = decryptContent('not-valid-ciphertext', 'anyPin');
    expect(result).toBeNull();
  });

  it('returns null for empty ciphertext string', () => {
    const result = decryptContent('', 'anyPin');
    expect(result).toBeNull();
  });
});
