// Tab di /admin sincronizzata col parametro ?tab=: il link di una notifica deve funzionare anche dopo aver cambiato tab a mano.
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d ?? k }) }));
vi.mock('react-hot-toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../lib/api', () => ({ default: { get: vi.fn(async () => ({ data: null })) } }));
vi.mock('../tabs/DashboardTab', () => ({ default: () => <div>tab-dashboard</div> }));
vi.mock('../tabs/UsersTab', () => ({ default: () => <div>tab-users</div> }));
vi.mock('../tabs/AuditTab', () => ({ default: () => <div>tab-audit</div> }));
vi.mock('../tabs/SettingsTab', () => ({ default: () => <div>tab-settings</div> }));
vi.mock('../tabs/RequestsTab', () => ({ default: () => <div>tab-requests</div> }));
vi.mock('../tabs/SystemHealthTab', () => ({ default: () => <div>tab-health</div> }));
vi.mock('../tabs/AnnouncementsTab', () => ({ default: () => <div>tab-announcements</div> }));
vi.mock('../tabs/ChatFilesTab', () => ({ default: () => <div>tab-chatFiles</div> }));
vi.mock('../tabs/VaultRecoveryTab', () => ({ default: () => <div>tab-vaultRecovery</div> }));

import AdminPage from '../AdminPage';

function Nav() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/admin?tab=vaultRecovery')}>go-recovery</button>;
}
const mount = (url: string) => render(<MemoryRouter initialEntries={[url]}><Nav /><AdminPage /></MemoryRouter>);

describe('AdminPage: tab e parametro ?tab=', () => {
  it('?tab=vaultRecovery apre quella tab', async () => {
    mount('/admin?tab=vaultRecovery');
    expect(await screen.findByText('tab-vaultRecovery')).toBeTruthy();
  });

  it('un tab id sconosciuto ripiega sulla dashboard', async () => {
    mount('/admin?tab=nope');
    expect(await screen.findByText('tab-dashboard')).toBeTruthy();
  });

  it('dopo aver cliccato un altro tab, navigare di nuovo a ?tab=vaultRecovery la riapre', async () => {
    mount('/admin?tab=vaultRecovery');
    await screen.findByText('tab-vaultRecovery');
    fireEvent.click(screen.getByText('Users'));
    expect(await screen.findByText('tab-users')).toBeTruthy();
    fireEvent.click(screen.getByText('go-recovery'));
    await waitFor(() => expect(screen.getByText('tab-vaultRecovery')).toBeTruthy());
  });
});
