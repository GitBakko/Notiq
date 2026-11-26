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

describe('NotificationItem SYSTEM vaultRecovery.admin', () => {
  it('testo con l email e click verso la tab admin del recupero vault', () => {
    const n = { ...notif({ localizationKey: 'notifications.vaultRecovery.adminRequested', localizationArgs: { email: 'mario@example.com' }, requestId: 'r1' }), type: 'SYSTEM' } as Notification;
    renderItem(n);
    expect(screen.getByText(/mario@example\.com requested a vault recovery/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Vault recovery: new request'));
    expect(nav).toHaveBeenCalledWith('/admin?tab=vaultRecovery');
  });
});

describe('NotificationItem VAULT_RECOVERY', () => {
  it('localizationArgs.fingerprint: testo tradotto con il fingerprint, non il message del server', () => {
    renderItem(notif({ localizationKey: 'notifications.vaultRecovery.requested', localizationArgs: { fingerprint: 'ABCD-1234' } }));
    expect(screen.getByText(/Request code: ABCD-1234/)).toBeInTheDocument();
    expect(screen.getByText('Vault recovery requested')).toBeInTheDocument();
    expect(screen.queryByText('SERVER_MESSAGE_IT')).toBeNull();
  });

  it('il click porta a /vault?recovery=1 (la cerimonia di recupero)', () => {
    renderItem(notif({ localizationKey: 'notifications.vaultRecovery.requested', localizationArgs: { fingerprint: 'ABCD-1234' } }));
    fireEvent.click(screen.getByText('Vault recovery requested'));
    expect(nav).toHaveBeenCalledWith('/vault?recovery=1');
  });
});

// P3: reset del vault (SYSTEM, localizationKey notifications.vaultReset.*)
describe('NotificationItem SYSTEM vaultReset', () => {
  const sys = (key: string, args?: Record<string, unknown>) =>
    ({ ...notif({ localizationKey: key, localizationArgs: args, requestId: 'r1' }), type: 'SYSTEM' }) as Notification;

  it('scheduled (utente): testo con la data, click verso /vault', () => {
    renderItem(sys('notifications.vaultReset.scheduled', { date: '4 Dec 2026, 10:00' }));
    expect(screen.getByText(/deleted on 4 Dec 2026, 10:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Vault reset scheduled'));
    expect(nav).toHaveBeenCalledWith('/vault');
  });

  it.each([
    ['cancelled', 'Vault reset cancelled', /reset on your account was cancelled/],
    ['completed', 'Vault reset completed', /Your vault was reset/],
  ])('%s (utente): titolo e testo tradotti, click verso /vault', (k, title, text) => {
    renderItem(sys(`notifications.vaultReset.${k}`));
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByText(title));
    expect(nav).toHaveBeenCalledWith('/vault');
  });

  it.each(['adminScheduled', 'adminCancelled', 'adminCompleted'])('%s (admin): testo con l\'email del proprietario, click verso la tab admin', (k) => {
    renderItem(sys(`notifications.vaultReset.${k}`, { email: 'mario@example.com' }));
    expect(screen.getByText(/mario@example\.com/)).toBeInTheDocument();
    expect(screen.queryByText('SERVER_TITLE')).toBeNull();
    fireEvent.click(screen.getByText(/mario@example\.com/));
    // type=RESET: la tab filtra RECOVERY di default e l'admin non vedrebbe la richiesta di reset
    expect(nav).toHaveBeenCalledWith('/admin?tab=vaultRecovery&type=RESET');
  });
});
