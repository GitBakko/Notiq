import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import i18next from 'i18next';
import en from '../../../locales/en.json';

const nav = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => nav }));

import NotificationItem from '../NotificationItem';
import type { Notification } from '../notificationService';

const i18n = i18next.createInstance();
await i18n.init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });

const notif = (data: Record<string, unknown>): Notification =>
  ({
    id: 'n1', type: 'VAULT_RECOVERY', title: 'SERVER_TITLE', message: 'SERVER_MESSAGE_IT', isRead: false,
    createdAt: new Date().toISOString(), data,
  }) as unknown as Notification;

const renderItem = (n: Notification) =>
  render(<I18nextProvider i18n={i18n}><NotificationItem notification={n} onRead={vi.fn()} onDelete={vi.fn()} /></I18nextProvider>);

beforeEach(() => nav.mockReset());

describe('NotificationItem VAULT_RECOVERY', () => {
  it('localizationArgs.fingerprint: testo tradotto con il fingerprint, non il message del server', () => {
    renderItem(notif({ localizationKey: 'notifications.vaultRecovery.requested', localizationArgs: { fingerprint: 'ABCD-1234' } }));
    expect(screen.getByText(/Request code: ABCD-1234/)).toBeInTheDocument();
    expect(screen.getByText('Vault recovery requested')).toBeInTheDocument();
    expect(screen.queryByText('SERVER_MESSAGE_IT')).toBeNull();
  });

  it('il click porta a /vault', () => {
    renderItem(notif({ localizationKey: 'notifications.vaultRecovery.requested', localizationArgs: { fingerprint: 'ABCD-1234' } }));
    fireEvent.click(screen.getByText('Vault recovery requested'));
    expect(nav).toHaveBeenCalledWith('/vault');
  });
});
