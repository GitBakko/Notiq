import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

const updateNote = vi.fn();
vi.mock('../../notes/noteService', () => ({
  updateNote: (...a: unknown[]) => updateNote(...a),
  permanentlyDeleteNote: vi.fn(),
}));
vi.mock('../../../store/vaultStore', () => ({
  useVaultStore: () => ({ pin: '1234' }),
}));
vi.mock('../../../lib/api', () => ({ default: { get: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import CredentialForm from '../CredentialForm';

const note = { id: 'n1', title: 'T', content: '', noteType: 'CREDENTIAL', isVault: true } as never;

describe('CredentialForm with never-hydrated content', () => {
  beforeEach(() => { vi.useFakeTimers(); updateNote.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never calls updateNote when content is empty (typing + timers + unmount)', () => {
    const { container, unmount } = render(<CredentialForm note={note} onBack={() => {}} />);
    // Fields must not be editable; if any input exists, typing into it must still not save
    container.querySelectorAll('input').forEach((i) => fireEvent.change(i, { target: { value: 'x' } }));
    act(() => { vi.advanceTimersByTime(5000); });
    unmount();
    expect(updateNote).not.toHaveBeenCalled();
    expect(container.querySelectorAll('input').length).toBe(0);
  });
});
