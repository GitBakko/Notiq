import { test, expect, type Locator } from '@playwright/test';
import { createNote, registerAndLogin } from './helpers';
import { apiFor, createCredentialUi, lockUi, setupVaultUi, unlockUi } from './vault-helpers';

async function sizeOf(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Element has no bounding box');
  return { width: box.width, height: box.height };
}

async function expectMinSize(locator: Locator, width = 44, height = 44) {
  const box = await sizeOf(locator);
  expect(box.width).toBeGreaterThanOrEqual(width);
  expect(box.height).toBeGreaterThanOrEqual(height);
}

async function contrast(locator: Locator): Promise<number> {
  return locator.evaluate((target) => {
    const channels = (css: string) => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (rgb: number[]) => {
      const c = rgb.map((v) => {
        const n = v / 255;
        return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const fg = luminance(channels(getComputedStyle(target).color));
    let el: Element | null = target;
    let bg = [255, 255, 255];
    while (el) {
      const color = getComputedStyle(el).backgroundColor;
      const rgb = channels(color);
      if (rgb.length === 3 && !/rgba\([^)]*,\s*0\)/.test(color) && color !== 'transparent') { bg = rgb; break; }
      el = el.parentElement;
    }
    const back = luminance(bg);
    return (Math.max(fg, back) + 0.05) / (Math.min(fg, back) + 0.05);
  });
}

async function expectContrast(locator: Locator, minimum: number) {
  expect(await contrast(locator)).toBeGreaterThanOrEqual(minimum);
}

async function openVault(page: import('@playwright/test').Page) {
  await page.goto('/vault');
  const pin = page.getByPlaceholder('Enter PIN');
  await Promise.race([
    pin.waitFor({ state: 'visible' }),
    page.getByRole('button', { name: 'Vault settings', exact: true }).waitFor({ state: 'visible' }),
  ]);
  if (await pin.count()) await unlockUi(page);
  await expect(page.getByRole('button', { name: 'Vault settings', exact: true })).toBeVisible({ timeout: 30000 });
}

test('M.3/M.5/M.6: target 44 px, dialog, contrasti e tema system', async ({ page }) => {
  test.setTimeout(300000);
  const user = await registerAndLogin(page, { name: 'Vault Accessibility' });
  const api = await apiFor(page);
  await setupVaultUi(page, user);
  await createCredentialUi(page, api, { title: 'A11y Credential', siteUrl: 'https://example.com', username: 'bob@example.com', password: 'pw-a11y', notes: '' });
  await page.locator('input[type="url"]').fill('https://example.com');

  for (const width of [320, 375, 412]) {
    await page.setViewportSize({ width, height: 800 });
    await openVault(page);
    await expect(page.getByText('A11y Credential', { exact: true })).toBeVisible({ timeout: 30000 });
    for (const name of ['All', 'Notes', 'Credentials', 'Sort by']) await expectMinSize(page.getByRole('button', { name, exact: true }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

    await page.getByText('A11y Credential', { exact: true }).click();
    await expect(page.getByPlaceholder('Enter password')).toBeVisible({ timeout: 30000 });
    for (const name of ['Back', 'Delete', 'Copy URL', 'Open website', 'Copy username', 'Copy password', 'Generate password', 'Show password']) {
      const button = page.getByRole('button', { name, exact: true });
      try {
        await expectMinSize(name === 'Delete' ? button.last() : button);
      } catch (e) {
        throw new Error(`${name}: ${(e as Error).message}`);
      }
    }
    for (const input of await page.locator('main input:visible').all()) await expectMinSize(input, 0, 44);
    for (const heading of await page.getByRole('heading', { level: 4 }).all()) await expectContrast(heading, 4.5);
    await expectContrast(page.getByRole('button', { name: 'Delete', exact: true }).last(), 3);
    await expectContrast(page.getByRole('button', { name: 'Show password', exact: true }), 3);

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Remove from this device', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove the vault from this device?', exact: true });
    await expectMinSize(dialog.getByRole('button', { name: 'Cancel', exact: true }), 0, 44);
    await expectMinSize(dialog.getByRole('button', { name: 'Remove from this device', exact: true }), 0, 44);
    await expectMinSize(dialog.getByRole('button', { name: 'Close', exact: true }));
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  }

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveClass(/light/);
  await openVault(page);
  await lockUi(page);
  await unlockUi(page);
  await expectContrast(page.getByText('Vault unlocked', { exact: true }), 4.5);
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto('/notes');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await api.dispose();
});

test('contrasti NoteEditor: icone normali, hover, attive e dark mode', async ({ page }) => {
  await registerAndLogin(page, { name: 'Editor Contrast' });
  const api = await apiFor(page);
  await createNote(page, 'Contrast Note', 'Body');
  const id = new URL(page.url()).searchParams.get('noteId')!;
  await api.put(`/api/notes/${id}`, { data: { isPinned: true, reminderDate: '2026-12-01T15:55:00.000Z' } });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await page.addStyleTag({ content: '* { transition: none !important }' });
  const reminder = page.getByRole('button', { name: 'Edit reminder', exact: true });
  const pin = page.getByRole('button', { name: 'Unpin Note', exact: true });
  const vault = page.getByRole('button', { name: 'Add to Vault', exact: true });
  const del = page.getByRole('banner').getByRole('button', { name: 'Delete', exact: true });

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((v) => document.documentElement.className = v, theme);
    for (const button of [reminder, pin, vault, del]) {
      await expectContrast(button, 3);
      await button.hover();
      await expectContrast(button, 3);
    }
    if (theme === 'dark') {
      for (const button of [reminder, pin, vault, del]) {
        const bg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(['rgb(255, 251, 235)', 'rgb(236, 253, 245)', 'rgb(254, 242, 242)']).not.toContain(bg);
      }
    }
  }
  await api.dispose();
});
