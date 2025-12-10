import { test, expect } from '@playwright/test';
import { v4 as uuidv4 } from 'uuid';

test.describe('Authentication', () => {
  test('should register a new user', async ({ page }) => {
    const email = `test-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Test User'); // Name
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');

    // Should redirect to /notes after successful registration (auto-login, then redirect from / to /notes)
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
    // Check for sidebar or something that indicates logged in state
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
  });

  test('should login with existing user', async ({ page }) => {
    const email = `login-${uuidv4()}@example.com`;
    const password = 'password123';

    // Register first (which logs in)
    await page.goto('/register');
    await page.fill('input[type="text"]', 'Login User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });

    // Wait for sidebar to be visible to ensure we are logged in and UI is ready
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();

    // Logout to test login
    await page.click('button[title="Logout"]');
    await expect(page).toHaveURL('/login', { timeout: 10000 });

    // Now login
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });
    await expect(page.getByTestId('sidebar-item-notes')).toBeVisible();
  });

  test('should logout', async ({ page }) => {
    const email = `logout-${uuidv4()}@example.com`;
    const password = 'password123';

    await page.goto('/register');
    await page.fill('input[type="text"]', 'Logout User');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/notes/, { timeout: 10000 });

    // Logout
    await page.click('button[title="Logout"]');

    await expect(page).toHaveURL('/login', { timeout: 10000 });
  });
});
