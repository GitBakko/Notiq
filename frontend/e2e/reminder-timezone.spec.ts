import { test, expect } from '@playwright/test';
import { createNote, registerAndLogin } from './helpers';
import { apiFor, createSecureNoteUi, lockUi, noteIdOf, setupVaultUi, unlockUi } from './vault-helpers';

test.use({ timezoneId: 'Europe/Rome' });

const reminderInput = (page: import('@playwright/test').Page) => page.locator('input[type="datetime-local"]').last();

async function fillAndExpectUtc(page: import('@playwright/test').Page, id: string, local: string, utc: string) {
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/notes/${id}`) && r.request().method() === 'PUT' && r.status() === 200);
  await reminderInput(page).fill(local, { force: true });
  const response = await saved;
  expect(response.request().postDataJSON().reminderDate).toBe(utc);
}

test('nota normale: il promemoria resta alla stessa ora locale dopo il reload', async ({ page }) => {
  await registerAndLogin(page, { name: 'Reminder Local Time' });
  await createNote(page, 'Reminder TZ', 'Body');
  const id = noteIdOf(page);
  await fillAndExpectUtc(page, id, '2026-12-01T15:55', '2026-12-01T14:55:00.000Z');
  await page.reload();
  await expect(reminderInput(page)).toHaveValue('2026-12-01T15:55');
});

test('nota vault: il promemoria resta alla stessa ora locale dopo lock e unlock', async ({ page }) => {
  const user = await registerAndLogin(page, { name: 'Vault Reminder Local Time' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  const id = await createSecureNoteUi(page, api, { title: 'Vault Reminder TZ', body: 'Body' });
  await fillAndExpectUtc(page, id, '2026-10-23T15:55', '2026-10-23T13:55:00.000Z');
  await lockUi(page);
  await unlockUi(page);
  await page.getByText('Vault Reminder TZ', { exact: true }).click();
  await expect(reminderInput(page)).toHaveValue('2026-10-23T15:55');
  await api.dispose();
});

test('un promemoria già salvato in UTC è mostrato in ora locale senza una nuova PUT', async ({ page }) => {
  await registerAndLogin(page, { name: 'Reminder Existing UTC' });
  const api = await apiFor(page);
  await createNote(page, 'Reminder Existing', 'Body');
  const id = noteIdOf(page);
  await api.put(`/api/notes/${id}`, { data: { reminderDate: '2026-10-23T13:55:00.000Z' } });
  const puts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith(`/api/notes/${id}`)) puts.push(r.url()); });
  await page.reload();
  await expect(reminderInput(page)).toHaveValue('2026-10-23T15:55');
  await page.waitForTimeout(3000);
  expect(puts).toHaveLength(0);
  await api.dispose();
});
