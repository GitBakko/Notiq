import { test, expect } from '@playwright/test';
import { registerAndLogin } from './helpers';
import { apiFor } from './vault-helpers';

async function createBoard(page: import('@playwright/test').Page, title: string) {
  await page.goto('/kanban');
  await page.getByRole('button', { name: 'New Board', exact: true }).first().click();
  await page.getByPlaceholder('Board title').fill(title);
  await page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(title, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function openTransformModal(page: import('@playwright/test').Page, title: string) {
  const api = await apiFor(page);
  const notebooks = await (await api.get('/api/notebooks')).json();
  const item = (text: string) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const content = JSON.stringify({ type: 'doc', content: [{ type: 'bulletList', content: [item('alpha'), item('beta')] }] });
  const note = await (await api.post('/api/notes', { data: { title, content, notebookId: notebooks[0].id } })).json();
  await api.dispose();
  await page.goto(`/notes?noteId=${note.id}`);
  const editor = page.locator('.ProseMirror');
  await expect(editor).toBeVisible({ timeout: 15000 });
  await editor.press('Control+A');
  await editor.click({ button: 'right' });
  await page.getByText('Transform to Kanban Board', { exact: true }).click();
}

async function cardsOf(api: import('@playwright/test').APIRequestContext, boardId: string) {
  const detail = await (await api.get(`/api/kanban/boards/${boardId}`)).json();
  return (detail.columns ?? []).flatMap((c: { cards?: { title: string }[] }) => (c.cards ?? []).map((card) => card.title));
}

test('trasformazione in Kanban: dopo Back usa solo la board B selezionata', async ({ page }) => {
  await registerAndLogin(page, { name: 'Kanban Transform Existing' });
  await createBoard(page, 'Board A');
  await createBoard(page, 'Board B');
  await page.goto('/notes');
  await openTransformModal(page, 'Transform existing');
  await page.getByText('Board A', { exact: true }).click();
  await page.getByRole('button', { name: 'To Do', exact: false }).waitFor({ state: 'visible' });
  await page.getByRole('dialog').getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByText('Board B', { exact: true }).click();
  await page.getByRole('button', { name: /^To Do/ }).click();
  await page.getByRole('button', { name: 'No, keep them', exact: true }).click();
  await expect(page).toHaveURL(/boardId=/, { timeout: 30000 });
  const boardId = new URL(page.url()).searchParams.get('boardId')!;
  const api = await apiFor(page);
  await expect.poll(() => cardsOf(api, boardId), { timeout: 30000 }).toEqual(['alpha', 'beta']);
  const boards = await (await api.get('/api/kanban/boards')).json();
  const boardA = boards.find((b: { title: string }) => b.title === 'Board A');
  expect(await cardsOf(api, boardA.id)).toEqual([]);
  await api.dispose();
});

test('trasformazione in Kanban: una board nuova mostra subito le colonne e riceve le card', async ({ page }) => {
  await registerAndLogin(page, { name: 'Kanban Transform New' });
  await openTransformModal(page, 'Transform new');
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  await page.getByPlaceholder('Board title').fill('Board Created Inline');
  await page.getByRole('button', { name: 'Transform', exact: true }).click();
  await page.getByRole('button', { name: /^To Do/ }).click();
  await page.getByRole('button', { name: 'No, keep them', exact: true }).click();
  await expect(page).toHaveURL(/boardId=/, { timeout: 30000 });
  const boardId = new URL(page.url()).searchParams.get('boardId')!;
  const api = await apiFor(page);
  await expect.poll(() => cardsOf(api, boardId), { timeout: 30000 }).toEqual(['alpha', 'beta']);
  await api.dispose();
});
