import { test, expect, request as pwRequest } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';
import { registerAndLogin } from './helpers';

const API_BASE = 'http://localhost:3001';
const SUPERADMIN_EMAIL = 'superadmin@notiq.ai';
const SUPERADMIN_PASSWORD = 'superadmin';

test.describe('Authentication', () => {
  test.fixme('should register a new user', async ({ page }) => {
    // FIXME: In dev env SMTP is not configured so the register endpoint returns 500 even though the
    // user row IS created (bug: sendNotificationEmail throws after DB insert, polluting the response).
    // The real fix is in auth.service.ts — catch SMTP errors and return success regardless.
    // When fixed, the expected UX is: form fills → submit → "Registration Successful!" success screen.
    const email = `test-${uuidv4()}@example.com`;
    const password = 'password123';

    const api = await pwRequest.newContext({ baseURL: API_BASE });
    const loginRes = await api.post('/api/auth/login', {
      data: { email: SUPERADMIN_EMAIL, password: SUPERADMIN_PASSWORD },
    });
    const { token: saToken } = await loginRes.json();
    const inviteRes = await api.post('/api/invites', {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    const { code: inviteCode } = await inviteRes.json();
    await api.dispose();

    await page.goto('/register');
    await page.fill('#name', 'Test User');
    await page.fill('#email', email);
    await page.fill('#password', password);
    await page.fill('#invitationCode', inviteCode);
    await page.click('button[type="submit"]');

    // After successful registration the app shows a "check your email" success screen
    // (no auto-login; email verification is required before login is allowed).
    await expect(page.getByText('Registration Successful!')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/check your email/i)).toBeVisible({ timeout: 5000 });
  });

  test('should login with existing user', async ({ page }) => {
    // Provision a fully verified user via API, then test UI login flow.
    const user = await registerAndLogin(page, { name: 'Login User' });

    // We're now on /notes — logout to test login
    await page.click('button[title="Logout"]');
    await expect(page).toHaveURL('/login', { timeout: 10000 });

    // Now login with the same credentials
    await page.fill('input[type="email"]', user.email);
    await page.fill('input[type="password"]', user.password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
  });

  test('should logout', async ({ page }) => {
    await registerAndLogin(page, { name: 'Logout User' });

    // Logout via UI
    await page.click('button[title="Logout"]');

    await expect(page).toHaveURL('/login', { timeout: 10000 });
  });
});
