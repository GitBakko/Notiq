import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

const state = { keys: {} as unknown };
vi.mock('../../../store/vaultStore', () => ({
  useVaultStore: (sel: (s: typeof state) => unknown) => sel(state),
}));
const decryptItem = vi.fn();
vi.mock('../../../lib/vaultCodec', () => ({ decryptItem: (...a: unknown[]) => decryptItem(...a) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import CredentialCard from '../CredentialCard';

const ENV = 'nv3.1.AAAAAAAAAAAAAAAA.' + 'A'.repeat(30);
const base = { id: 'n1', title: '', content: ENV, noteType: 'CREDENTIAL', updatedAt: '2026-01-01T00:00:00Z', tags: [] };
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe('CredentialCard', () => {
  it('shows the decrypted title and domain (Dexie title is empty)', async () => {
    decryptItem.mockResolvedValue({ t: 'Mail', c: JSON.stringify({ siteUrl: 'https://mail.example.com/x', username: '', password: '', notes: '' }) });
    render(<CredentialCard note={base as never} isSelected={false} onClick={() => {}} />);
    await flush();
    expect(screen.getByText('Mail')).toBeTruthy();
    expect(screen.getByText('mail.example.com')).toBeTruthy();
  });

  it('falls back to untitled on decrypt failure or non-envelope content', async () => {
    decryptItem.mockReset().mockRejectedValue(new Error('x'));
    const { unmount } = render(<CredentialCard note={base as never} isSelected={false} onClick={() => {}} />);
    await flush();
    expect(screen.getByText('vault.credential.untitled')).toBeTruthy();
    unmount();
    decryptItem.mockClear();
    render(<CredentialCard note={{ ...base, content: 'legacy-ciphertext' } as never} isSelected={false} onClick={() => {}} />);
    await flush();
    expect(decryptItem).not.toHaveBeenCalled();
    expect(screen.getByText('vault.credential.untitled')).toBeTruthy();
  });

  it('B.1: riga legacy (non envelope) con titolo: mostra il titolo; riga envelope con titolo ma senza chiavi: untitled', async () => {
    decryptItem.mockReset();
    const { unmount } = render(<CredentialCard note={{ ...base, title: 'Banca', content: 'legacy-ciphertext' } as never} isSelected={false} onClick={() => {}} />);
    await flush();
    expect(screen.getByText('Banca')).toBeTruthy();
    unmount();
    const prev = state.keys;
    state.keys = null;
    render(<CredentialCard note={{ ...base, title: 'Segreto', content: ENV } as never} isSelected={false} onClick={() => {}} />);
    await flush();
    state.keys = prev;
    expect(screen.queryByText('Segreto')).toBeNull();
    expect(screen.getByText('vault.credential.untitled')).toBeTruthy();
  });
});
