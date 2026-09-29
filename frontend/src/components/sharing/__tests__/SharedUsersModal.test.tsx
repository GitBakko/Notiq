import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// i18n: return the key verbatim (mirrors BulkArchiveDialog.test.tsx)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import SharedUsersModal, { type SharedUserInfo } from '../SharedUsersModal';

const owner = { id: 'owner-1', name: 'Olga Owner', email: 'olga@example.com' };

describe('SharedUsersModal — declined shares', () => {
  it('does not list a DECLINED share among the users with access', () => {
    const users: SharedUserInfo[] = [
      { id: 'u-acc', name: 'Alice Accepted', email: 'alice@example.com', permission: 'READ', status: 'ACCEPTED' },
      { id: 'u-pen', name: 'Bob Pending', email: 'bob@example.com', permission: 'READ', status: 'PENDING' },
      { id: 'u-dec', name: 'Carol Declined', email: 'carol@example.com', permission: 'WRITE', status: 'DECLINED' },
    ];

    render(<SharedUsersModal isOpen onClose={() => {}} users={users} owner={owner} />);

    expect(screen.getByText('Alice Accepted')).toBeInTheDocument();
    expect(screen.getByText('Bob Pending')).toBeInTheDocument();
    // `status !== 'PENDING'` put whoever said no in the "has access" list, with a
    // permission badge, indistinguishable from someone who accepted.
    expect(screen.queryByText('Carol Declined')).not.toBeInTheDocument();
    expect(screen.queryByText('carol@example.com')).not.toBeInTheDocument();
  });

  it('shows the empty state when the only other share was declined', () => {
    const users: SharedUserInfo[] = [
      { id: 'u-dec', name: 'Carol Declined', email: 'carol@example.com', permission: 'READ', status: 'DECLINED' },
    ];

    render(<SharedUsersModal isOpen onClose={() => {}} users={users} owner={owner} />);

    expect(screen.getByText('sharing.noOtherUsers')).toBeInTheDocument();
    expect(screen.queryByText('Carol Declined')).not.toBeInTheDocument();
  });
});
