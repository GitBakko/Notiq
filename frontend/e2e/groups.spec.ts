import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';

test.describe('Groups', () => {
  test('should create a new group', async ({ page }) => {
    test.setTimeout(30000);
    await registerAndLogin(page, { name: 'Group Creator' });

    // Navigate to groups page via sidebar
    await page.getByTestId('sidebar-item-groups').click();
    await expect(page).toHaveURL(/\/groups/, { timeout: 5000 });

    // Click "Create Group" button
    await page.getByRole('button', { name: /create group/i }).click();

    // Fill group name in the inline form
    await page.fill('input[placeholder="Group name"]', 'Test Group');
    await page.fill('input[placeholder="Description (optional)"]', 'A test group');

    // Submit via the Create button
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    // Verify group appears in the list (use heading to avoid matching the description text)
    await expect(page.getByRole('heading', { name: 'Test Group' })).toBeVisible({ timeout: 5000 });
  });

  test('should add a member to a group', async ({ browser }) => {
    test.setTimeout(60000);

    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    const userA = await registerAndLogin(pageA, { name: 'Group Owner' });
    const userB = await registerAndLogin(pageB, { name: 'Group Member' });

    // User A creates a group
    await pageA.getByTestId('sidebar-item-groups').click();
    await expect(pageA).toHaveURL(/\/groups/, { timeout: 5000 });

    await pageA.getByRole('button', { name: /create group/i }).click();
    await pageA.fill('input[placeholder="Group name"]', 'Collab Group');
    await pageA.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(pageA.getByRole('heading', { name: 'Collab Group' })).toBeVisible({ timeout: 5000 });

    // Expand the group to reveal members section
    await pageA.getByRole('heading', { name: 'Collab Group' }).click();

    // Add member by email — the add member input is inside the expanded group
    const emailInput = pageA.locator('input[placeholder="Enter email address"]');
    await expect(emailInput).toBeVisible({ timeout: 5000 });
    await emailInput.fill(userB.email);

    // Submit by pressing Enter
    await emailInput.press('Enter');

    // The backend adds the member to DB but may fail on SMTP notification email.
    // Wait a moment for the API call, then reload the page to see the member
    // regardless of whether the notification email succeeded.
    await pageA.waitForTimeout(2000);
    await pageA.reload();
    await expect(pageA.getByRole('heading', { name: 'Collab Group' })).toBeVisible({ timeout: 5000 });

    // Expand the group again after reload
    await pageA.getByRole('heading', { name: 'Collab Group' }).click();

    // Verify member appears in the expanded group — name is shown for registered users.
    // Use .first() because the member entry renders both the name and email as separate <p> elements.
    await expect(
      pageA.getByText(userB.name).first()
    ).toBeVisible({ timeout: 10000 });

    await contextA.close();
    await contextB.close();
  });

  test('should delete a group', async ({ page }) => {
    test.setTimeout(30000);
    await registerAndLogin(page, { name: 'Group Deleter' });

    // Navigate to groups page
    await page.getByTestId('sidebar-item-groups').click();
    await expect(page).toHaveURL(/\/groups/, { timeout: 5000 });

    // Create a group first
    await page.getByRole('button', { name: /create group/i }).click();
    await page.fill('input[placeholder="Group name"]', 'Delete Me Group');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Delete Me Group' })).toBeVisible({ timeout: 5000 });

    // Expand the group
    await page.getByRole('heading', { name: 'Delete Me Group' }).click();

    // Click the text "Delete" button in the expanded actions row (not icon-only buttons)
    await page.getByText('Delete', { exact: true }).click();

    // Confirm deletion in the ConfirmDialog (use name to distinguish from Notifications panel)
    const confirmDialog = page.getByRole('dialog', { name: 'Delete Group' });
    await expect(confirmDialog).toBeVisible({ timeout: 5000 });
    await confirmDialog.getByRole('button', { name: /delete/i }).click();

    // Verify group is removed
    await expect(page.getByRole('heading', { name: 'Delete Me Group' })).not.toBeVisible({ timeout: 5000 });
  });
});
