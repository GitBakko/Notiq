import { describe, it, expect, vi, beforeEach } from 'vitest';

const decryptContent = vi.fn();
const encryptContent = vi.fn();
vi.mock('../../../utils/crypto', () => ({
  decryptContent: (...a: unknown[]) => decryptContent(...a),
  encryptContent: (...a: unknown[]) => encryptContent(...a),
}));
// decryptCredential legacy non deve toccare lo store: se lo importasse, questo mock fa fallire il test
vi.mock('../../../store/vaultStore', () => { throw new Error('credentialTypes must not import vaultStore'); });

import { decryptCredential, parseCredential, EMPTY_CREDENTIAL } from '../credentialTypes';

const data = { ...EMPTY_CREDENTIAL, username: 'bob' };

describe('credentialTypes (legacy + parse)', () => {
  beforeEach(() => { decryptContent.mockReset(); });

  it('decryptCredential works without the store and does not cache', () => {
    decryptContent.mockReturnValue(JSON.stringify(data));
    expect(decryptCredential('ct', '1234')).toEqual(data);
    expect(decryptCredential('ct', '1234')).toEqual(data);
    expect(decryptContent).toHaveBeenCalledTimes(2);
  });

  it('decryptCredential: wrong pin / non-object -> null', () => {
    decryptContent.mockReturnValueOnce('');
    expect(decryptCredential('ct', 'bad')).toBeNull();
    decryptContent.mockReturnValueOnce('"str"');
    expect(decryptCredential('ct', '1234')).toBeNull();
  });

  it('parseCredential accepts only JSON objects', () => {
    expect(parseCredential('{"siteUrl":"a"}')).toEqual({ siteUrl: 'a' });
    expect(parseCredential('[1]')).toBeNull();
    expect(parseCredential('null')).toBeNull();
    expect(parseCredential('{bad')).toBeNull();
  });
});
