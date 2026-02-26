# Sharing Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken email invitations, add sent invitations panel, add smart merge for note-to-kanban/tasklist transformations.

**Architecture:** Eliminate JWT tokens from sharing emails (replace with dashboard links), add GET /share/sent + POST /share/resend endpoints, add duplicate detection step in transform modals. All sharing acceptance goes through existing respond-id endpoint.

**Tech Stack:** Fastify 5, Prisma 7, React 19, i18next, TailwindCSS 3, react-hot-toast

---

### Task 1: Remove token generation from sharing services

**Files:**
- Modify: `backend/src/services/sharing.service.ts`
- Modify: `backend/src/services/tasklist-sharing.service.ts`

**Step 1: Remove JWT import and token generation from shareNote**

In `backend/src/services/sharing.service.ts`, remove the `import jwt from 'jsonwebtoken';` line (line 5).

In `shareNote()` (lines 68-73), remove the token generation block:
```typescript
// DELETE these lines:
const token = jwt.sign(
  { noteId, userId: targetUser.id, type: 'NOTE' },
  process.env.JWT_SECRET!,
  { expiresIn: '7d' }
);
```

Update the email call (lines 80-89) to pass `shareId` and `tab` instead of `token`:
```typescript
await emailService.sendNotificationEmail(
  targetUser.email,
  'SHARE_INVITATION',
  {
    sharerName: owner.name || owner.email,
    itemName: note.title,
    itemType: 'Note',
    shareId: sharedNote.id,
    tab: 'notes',
  }
);
```

**Step 2: Remove token generation from shareNotebook**

In `shareNotebook()` (lines 305-310), remove the token generation block:
```typescript
// DELETE these lines:
const token = jwt.sign(
  { notebookId, userId: targetUser.id, type: 'NOTEBOOK' },
  process.env.JWT_SECRET!,
  { expiresIn: '7d' }
);
```

Update the email call (lines 318-328) to pass `shareId` and `tab`:
```typescript
await emailService.sendNotificationEmail(
  targetUser.email,
  'SHARE_INVITATION',
  {
    sharerName: owner.name || owner.email,
    itemName: notebook.name,
    itemType: 'Notebook',
    shareId: sharedNotebook.id,
    tab: 'notebooks',
  }
);
```

**Step 3: Add shareId and tab to shareKanbanBoard email**

In `shareKanbanBoard()` (lines 630-638), update the email call:
```typescript
await emailService.sendNotificationEmail(email, 'SHARE_INVITATION', {
  sharerName,
  itemName: board.title,
  itemType: 'kanban board',
  shareId: share.id,
  tab: 'kanbanBoards',
});
```

**Step 4: Add shareId and tab to shareTaskList email**

In `backend/src/services/tasklist-sharing.service.ts`, update `shareTaskList()` email call (lines 60-68):
```typescript
await emailService.sendNotificationEmail(
  targetUser.email,
  'SHARE_INVITATION',
  {
    sharerName: owner.name || owner.email,
    itemName: taskList.title,
    itemType: 'Task List',
    shareId: sharedTaskList.id,
    tab: 'taskLists',
  }
);
```

**Step 5: Fix autoShareNoteForBoard email**

In `sharing.service.ts`, `autoShareNoteForBoard()` (lines 184-193), update:
```typescript
await emailService.sendNotificationEmail(
  targetUser.email,
  'SHARE_INVITATION',
  {
    sharerName,
    itemName: note.title,
    itemType: 'Note',
    shareId: '', // Auto-accepted, no action needed
    tab: 'notes',
  }
).catch((e) => logger.error(e, 'Failed to send auto-share email'));
```

**Step 6: Remove respondToShare function**

Delete the entire `respondToShare` function (lines 393-467) from `sharing.service.ts`.

**Step 7: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS (the jwt import should be removable since no other function uses it in this file)

---

### Task 2: Update email template

**Files:**
- Modify: `backend/src/services/email.service.ts`

**Step 1: Replace SHARE_INVITATION template**

Replace the `case 'SHARE_INVITATION':` block (lines 95-123) with a notification-style email that links to the dashboard:

```typescript
case 'SHARE_INVITATION': {
  const dashboardLink = data.shareId
    ? `${FRONTEND_URL}/shared?tab=${data.tab}&highlight=${data.shareId}`
    : `${FRONTEND_URL}/shared`;

  if (isIt) {
    const itemTypeIt = data.itemType === 'Note' ? 'la nota'
      : data.itemType === 'Notebook' ? 'il taccuino'
      : data.itemType === 'Task List' ? 'la lista attivita'
      : 'la board kanban';
    subject = `${escapeHtml(data.sharerName)} ti ha invitato a collaborare su: ${escapeHtml(data.itemName)}`;
    html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Invito alla Collaborazione</h2>
        <p><strong>${escapeHtml(data.sharerName)}</strong> vuole condividere ${itemTypeIt} "<strong>${escapeHtml(data.itemName)}</strong>" con te.</p>
        <p style="margin-top: 20px;">
          <a href="${dashboardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vedi Invito</a>
        </p>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">Accedi a Notiq per accettare o rifiutare l'invito.</p>
      </div>
    `;
  } else {
    subject = `${escapeHtml(data.sharerName)} invited you to collaborate on: ${escapeHtml(data.itemName)}`;
    html = `
      <div style="font-family: sans-serif; padding: 20px;">
        <h2>Collaboration Invitation</h2>
        <p><strong>${escapeHtml(data.sharerName)}</strong> wants to share the ${data.itemType} "<strong>${escapeHtml(data.itemName)}</strong>" with you.</p>
        <p style="margin-top: 20px;">
          <a href="${dashboardLink}" style="background: #10b981; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">View Invitation</a>
        </p>
        <p style="margin-top: 20px; font-size: 12px; color: #666;">Sign in to Notiq to accept or decline the invitation.</p>
      </div>
    `;
  }
  break;
}
```

**Step 2: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

---

### Task 3: Remove token-based response endpoint and frontend page

**Files:**
- Modify: `backend/src/routes/sharing.ts`
- Delete: `frontend/src/pages/RespondToShare.tsx`
- Modify: `frontend/src/App.tsx`

**Step 1: Remove POST /respond endpoint from routes**

In `backend/src/routes/sharing.ts`, delete lines 37-50 (the POST `/respond` handler) and lines 14-17 (the `respondSchema`).

**Step 2: Remove unused import**

If `respondSchema` was the only use of the `z.string().min(1)` pattern for tokens, clean up. The `respondByIdSchema` stays.

**Step 3: Verify backend build**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

**Step 4: Remove RespondToShare route from App.tsx**

In `frontend/src/App.tsx`, remove line 24 (`import RespondToShare...`) and line 63 (`<Route path="share/respond"...>`).

**Step 5: Delete RespondToShare.tsx**

Delete `frontend/src/pages/RespondToShare.tsx`.

**Step 6: Verify frontend build**

Run: `cd frontend && npx tsc -b`
Expected: PASS

---

### Task 4: Add GET /share/sent endpoint

**Files:**
- Modify: `backend/src/services/sharing.service.ts`
- Modify: `backend/src/routes/sharing.ts`

**Step 1: Add getSentShares function to sharing.service.ts**

Add at the end of the file (before the kanban section or at the very end):

```typescript
export const getSentShares = async (userId: string) => {
  const [notes, notebooks, taskLists, kanbanBoards] = await Promise.all([
    prisma.sharedNote.findMany({
      where: { note: { userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        note: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sharedNotebook.findMany({
      where: { notebook: { userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        notebook: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sharedTaskList.findMany({
      where: { taskList: { userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        taskList: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.sharedKanbanBoard.findMany({
      where: { board: { ownerId: userId } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        board: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
  ]);

  return { notes, notebooks, taskLists, kanbanBoards };
};
```

**Step 2: Add GET /sent route**

In `backend/src/routes/sharing.ts`, after the authenticate hook (line 52), add:

```typescript
// Get Sent Shares (all types, for "My Invitations" panel)
fastify.get('/sent', async (request) => {
  return sharingService.getSentShares(request.user.id);
});
```

**Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

---

### Task 5: Add POST /share/resend endpoint

**Files:**
- Modify: `backend/src/services/sharing.service.ts`
- Modify: `backend/src/routes/sharing.ts`

**Step 1: Add resendShareInvitation function**

Add to `sharing.service.ts`:

```typescript
export const resendShareInvitation = async (
  userId: string,
  type: 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN',
  shareId: string
) => {
  const owner = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  if (!owner) throw new Error('User not found');
  const sharerName = owner.name || owner.email;

  let targetEmail: string;
  let itemName: string;
  let itemType: string;
  let tab: string;

  if (type === 'NOTE') {
    const share = await prisma.sharedNote.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, note: { select: { title: true, userId: true } } },
    });
    if (!share || share.note.userId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.note.title;
    itemType = 'Note';
    tab = 'notes';
  } else if (type === 'NOTEBOOK') {
    const share = await prisma.sharedNotebook.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, notebook: { select: { name: true, userId: true } } },
    });
    if (!share || share.notebook.userId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.notebook.name;
    itemType = 'Notebook';
    tab = 'notebooks';
  } else if (type === 'TASKLIST') {
    const share = await prisma.sharedTaskList.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, taskList: { select: { title: true, userId: true } } },
    });
    if (!share || share.taskList.userId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.taskList.title;
    itemType = 'Task List';
    tab = 'taskLists';
  } else {
    const share = await prisma.sharedKanbanBoard.findUnique({
      where: { id: shareId },
      include: { user: { select: { email: true } }, board: { select: { title: true, ownerId: true } } },
    });
    if (!share || share.board.ownerId !== userId) throw new Error('Share not found');
    if (share.status !== 'PENDING') throw new Error('Only pending shares can be resent');
    targetEmail = share.user.email;
    itemName = share.board.title;
    itemType = 'kanban board';
    tab = 'kanbanBoards';
  }

  await emailService.sendNotificationEmail(targetEmail, 'SHARE_INVITATION', {
    sharerName,
    itemName,
    itemType,
    shareId,
    tab,
  });

  return { success: true };
};
```

**Step 2: Add POST /resend route**

In `backend/src/routes/sharing.ts`, add after the `/sent` route:

```typescript
// Resend share invitation email
fastify.post('/resend/:type/:id', async (request, reply) => {
  const { type, id } = request.params as { type: string; id: string };
  const validTypes = ['NOTE', 'NOTEBOOK', 'TASKLIST', 'KANBAN'];
  if (!validTypes.includes(type.toUpperCase())) {
    return reply.status(400).send({ message: 'Invalid type' });
  }

  try {
    const result = await sharingService.resendShareInvitation(
      request.user.id,
      type.toUpperCase() as 'NOTE' | 'NOTEBOOK' | 'TASKLIST' | 'KANBAN',
      id
    );
    return result;
  } catch (error: any) {
    if (error.message === 'Share not found') return reply.status(404).send({ message: error.message });
    if (error.message === 'Only pending shares can be resent') return reply.status(400).send({ message: error.message });
    throw error;
  }
});
```

**Step 3: Verify build**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

---

### Task 6: Add "Sent" view to SharedWithMePage

**Files:**
- Modify: `frontend/src/features/sharing/SharedWithMePage.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add i18n keys to en.json**

Add inside the `"sharing"` object:

```json
"sentInvitations": "Sent Invitations",
"received": "Received",
"sent": "Sent",
"sentSubtitle": "Invitations you've sent to others",
"noSentInvitations": "No sent invitations yet",
"resend": "Resend",
"cancel": "Cancel",
"revokeAccess": "Revoke",
"resendSuccess": "Invitation resent",
"resendFailed": "Failed to resend invitation",
"cancelSuccess": "Invitation cancelled",
"cancelFailed": "Failed to cancel invitation",
"revokeSuccess": "Access revoked",
"statusPending": "Pending",
"statusAccepted": "Accepted",
"statusDeclined": "Declined",
"sentTo": "Sent to",
"expiresIn": "Expires in {{days}} days",
"expired": "Expired"
```

**Step 2: Add i18n keys to it.json**

Add inside the `"sharing"` object:

```json
"sentInvitations": "Inviti Inviati",
"received": "Ricevuti",
"sent": "Inviati",
"sentSubtitle": "Inviti che hai inviato ad altri",
"noSentInvitations": "Nessun invito inviato",
"resend": "Reinvia",
"cancel": "Annulla",
"revokeAccess": "Revoca",
"resendSuccess": "Invito reinviato",
"resendFailed": "Impossibile reinviare l'invito",
"cancelSuccess": "Invito annullato",
"cancelFailed": "Impossibile annullare l'invito",
"revokeSuccess": "Accesso revocato",
"statusPending": "In attesa",
"statusAccepted": "Accettato",
"statusDeclined": "Rifiutato",
"sentTo": "Inviato a",
"expiresIn": "Scade tra {{days}} giorni",
"expired": "Scaduto"
```

**Step 3: Add Received/Sent toggle and sent data fetch to SharedWithMePage**

In `frontend/src/features/sharing/SharedWithMePage.tsx`:

Add state and types:
```typescript
const [view, setView] = useState<'received' | 'sent'>('received');
const [sentData, setSentData] = useState<any>(null);
const [isSentLoading, setIsSentLoading] = useState(false);
```

Add sent data fetch function:
```typescript
const fetchSentData = async () => {
  setIsSentLoading(true);
  try {
    const res = await api.get('/share/sent');
    setSentData(res.data);
  } catch (error) {
    console.error('Failed to fetch sent invitations', error);
  } finally {
    setIsSentLoading(false);
  }
};
```

Trigger fetch when switching to sent view:
```typescript
useEffect(() => {
  if (view === 'sent' && !sentData) {
    fetchSentData();
  }
}, [view]);
```

Add the Received/Sent toggle between the header and the tab bar:
```tsx
<div className="flex gap-2 px-6 pt-4">
  <button
    onClick={() => setView('received')}
    className={clsx(
      "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
      view === 'received'
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
    )}
  >
    {t('sharing.received')}
  </button>
  <button
    onClick={() => setView('sent')}
    className={clsx(
      "px-4 py-1.5 text-sm font-medium rounded-full transition-colors",
      view === 'sent'
        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
        : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
    )}
  >
    {t('sharing.sent')}
  </button>
</div>
```

**Step 4: Build the Sent view**

Add the sent view content. When `view === 'sent'`, render a list grouped by entity type (using the same tabs). Each item shows:
- Recipient name/email
- Status badge (PENDING yellow, ACCEPTED green, DECLINED red)
- Entity name
- createdAt date
- Actions: Resend (PENDING), Cancel/Revoke via existing DELETE endpoints

For resend handler:
```typescript
const handleResend = async (type: string, shareId: string) => {
  try {
    await api.post(`/share/resend/${type}/${shareId}`);
    toast.success(t('sharing.resendSuccess'));
  } catch {
    toast.error(t('sharing.resendFailed'));
  }
};
```

For cancel/revoke handler (reuse existing DELETE endpoints):
```typescript
const handleCancelOrRevoke = async (type: string, entityId: string, userId: string) => {
  try {
    const typeMap: Record<string, string> = {
      NOTE: 'notes', NOTEBOOK: 'notebooks', TASKLIST: 'tasklists', KANBAN: 'kanbans',
    };
    await api.delete(`/share/${typeMap[type]}/${entityId}/${userId}`);
    toast.success(t('sharing.cancelSuccess'));
    fetchSentData(); // Refresh
  } catch {
    toast.error(t('sharing.cancelFailed'));
  }
};
```

The entity ID to pass depends on type:
- NOTE: `share.note.id` (noteId), user: `share.user.id`
- NOTEBOOK: `share.notebook.id`, user: `share.user.id`
- TASKLIST: `share.taskList.id`, user: `share.user.id`
- KANBAN: `share.board.id`, user: `share.user.id`

**Step 5: Verify frontend build**

Run: `cd frontend && npx tsc -b`
Expected: PASS

---

### Task 7: Smart merge — TransformToKanbanModal

**Files:**
- Modify: `frontend/src/components/editor/TransformToKanbanModal.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Add i18n keys**

In `en.json` under `"editor.transform"`:
```json
"duplicatesFound": "{{count}} items already exist",
"duplicatesFoundSub": "Uncheck items you want to skip",
"statusNew": "New",
"statusDuplicate": "Duplicate",
"addSelected": "Add selected only",
"addAll": "Add all",
"noDuplicates": "No duplicates found"
```

In `it.json` under `"editor.transform"`:
```json
"duplicatesFound": "{{count}} voci gia presenti",
"duplicatesFoundSub": "Deseleziona le voci che vuoi saltare",
"statusNew": "Nuovo",
"statusDuplicate": "Duplicato",
"addSelected": "Aggiungi selezionati",
"addAll": "Aggiungi tutti",
"noDuplicates": "Nessun duplicato trovato"
```

**Step 2: Add 'review' step to the modal**

Change the `Step` type:
```typescript
type Step = 'board' | 'column' | 'review' | 'confirm-remove';
```

Add state for review:
```typescript
const [selectedColumnId, setSelectedColumnId] = useState<string>('');
const [itemChecklist, setItemChecklist] = useState<{ text: string; isDuplicate: boolean; checked: boolean }[]>([]);
```

**Step 3: Modify handleSelectColumn to check duplicates first**

Replace the current `handleSelectColumn` function. Instead of immediately creating cards, check for duplicates:

```typescript
function handleCheckDuplicates(columnId: string) {
  setSelectedColumnId(columnId);
  const column = boardDetail?.columns.find(c => c.id === columnId);
  const existingTitles = new Set(
    (column?.cards || []).map(c => c.title.trim().toLowerCase())
  );

  const checklist = items.map(item => {
    const title = item.text.split('\n')[0].trim().toLowerCase();
    const isDuplicate = existingTitles.has(title);
    return { text: item.text, isDuplicate, checked: !isDuplicate };
  });

  const hasDuplicates = checklist.some(i => i.isDuplicate);
  if (hasDuplicates) {
    setItemChecklist(checklist);
    setStep('review');
  } else {
    // No duplicates — proceed directly
    handleCreateCards(columnId, items);
  }
}
```

Extract card creation to a shared function:
```typescript
async function handleCreateCards(columnId: string, itemsToAdd: ListItemInfo[]) {
  setIsCreating(true);
  try {
    const boardTitle = boardDetail?.title || '';
    for (const item of itemsToAdd) {
      const lines = item.text.split('\n');
      const title = lines[0];
      const description = lines.length > 1 ? item.text : undefined;
      await createCard.mutateAsync({ columnId, title, description });
    }
    toast.success(t('editor.transform.kanbanSuccess', { count: itemsToAdd.length, board: boardTitle }));
    setStep('confirm-remove');
  } catch {
    toast.error(t('common.somethingWentWrong'));
  } finally {
    setIsCreating(false);
  }
}
```

**Step 4: Add review step UI**

In the column selection step, change `onClick={() => handleSelectColumn(col.id)}` to `onClick={() => handleCheckDuplicates(col.id)}`.

Add the review step rendering between column and confirm-remove:
```tsx
{step === 'review' && (
  <div className="space-y-3">
    <p className="text-sm text-gray-600 dark:text-gray-300">
      {t('editor.transform.duplicatesFound', { count: itemChecklist.filter(i => i.isDuplicate).length })}
    </p>
    <p className="text-xs text-gray-500 dark:text-gray-400">
      {t('editor.transform.duplicatesFoundSub')}
    </p>
    <div className="max-h-60 overflow-y-auto space-y-1">
      {itemChecklist.map((item, i) => (
        <label key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer">
          <input
            type="checkbox"
            checked={item.checked}
            onChange={() => {
              const updated = [...itemChecklist];
              updated[i] = { ...updated[i], checked: !updated[i].checked };
              setItemChecklist(updated);
            }}
            className="rounded border-gray-300 text-emerald-600 focus:ring-emerald-500"
          />
          <span className="flex-1 text-sm text-gray-900 dark:text-white truncate">{item.text}</span>
          <span className={clsx(
            "text-xs px-2 py-0.5 rounded-full font-medium",
            item.isDuplicate
              ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
              : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
          )}>
            {item.isDuplicate ? t('editor.transform.statusDuplicate') : t('editor.transform.statusNew')}
          </span>
        </label>
      ))}
    </div>
    <div className="flex gap-3 pt-2">
      <button
        onClick={() => {
          const selectedItems = items.filter((_, i) => itemChecklist[i].checked);
          if (selectedItems.length > 0) handleCreateCards(selectedColumnId, selectedItems);
          else { handleClose(); }
        }}
        disabled={isCreating}
        className="flex-1 py-2 px-4 text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 rounded-lg transition-colors"
      >
        {isCreating ? t('common.loading') : t('editor.transform.addSelected')}
      </button>
      <button
        onClick={() => handleCreateCards(selectedColumnId, items)}
        disabled={isCreating}
        className="flex-1 py-2 px-4 text-sm border border-gray-200 dark:border-gray-700 rounded-lg text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors disabled:opacity-50"
      >
        {t('editor.transform.addAll')}
      </button>
    </div>
  </div>
)}
```

**Step 5: Update title for review step**

Update the title computation:
```typescript
const title = step === 'board'
  ? t('editor.transform.toKanban')
  : step === 'column'
  ? t('editor.transform.selectColumn')
  : step === 'review'
  ? t('editor.transform.duplicatesFound', { count: itemChecklist.filter(i => i.isDuplicate).length })
  : t('editor.transform.removeFromNote');
```

**Step 6: Verify frontend build**

Run: `cd frontend && npx tsc -b`
Expected: PASS

---

### Task 8: Smart merge — TransformToTaskListModal

**Files:**
- Modify: `frontend/src/components/editor/TransformToTaskListModal.tsx`

**Step 1: Add 'review' step**

Same pattern as kanban. Change Step type:
```typescript
type Step = 'list' | 'review' | 'confirm-remove';
```

Add state:
```typescript
const [selectedListId, setSelectedListId] = useState<string>('');
const [selectedListTitle, setSelectedListTitle] = useState<string>('');
const [itemChecklist, setItemChecklist] = useState<{ text: string; isDuplicate: boolean; checked: boolean }[]>([]);
```

**Step 2: Modify handleSelectList to check duplicates**

Replace `handleSelectList`:
```typescript
function handleCheckDuplicates(listId: string, listTitle: string) {
  setSelectedListId(listId);
  setSelectedListTitle(listTitle);
  const list = taskLists?.find(l => l.id === listId);
  const existingTitles = new Set(
    (list?.items || []).map(i => i.text.trim().toLowerCase())
  );

  const checklist = items.map(item => {
    const isDuplicate = existingTitles.has(item.text.trim().toLowerCase());
    return { text: item.text, isDuplicate, checked: !isDuplicate };
  });

  const hasDuplicates = checklist.some(i => i.isDuplicate);
  if (hasDuplicates) {
    setItemChecklist(checklist);
    setStep('review');
  } else {
    handleAddItems(listId, listTitle, items);
  }
}
```

Extract item creation:
```typescript
async function handleAddItems(listId: string, listTitle: string, itemsToAdd: ListItemInfo[]) {
  setIsCreating(true);
  try {
    for (const item of itemsToAdd) {
      await addTaskItem(listId, item.text, 'MEDIUM');
    }
    toast.success(t('editor.transform.taskListSuccess', { count: itemsToAdd.length, list: listTitle }));
    setStep('confirm-remove');
  } catch {
    toast.error(t('common.somethingWentWrong'));
  } finally {
    setIsCreating(false);
  }
}
```

**Step 3: Add review step UI**

Same UI pattern as Task 7 Step 4, but with task list specific callbacks:
- "Add selected" calls `handleAddItems(selectedListId, selectedListTitle, selectedItems)`
- "Add all" calls `handleAddItems(selectedListId, selectedListTitle, items)`

**Step 4: Update button onClick in list selection**

Change `onClick={() => handleSelectList(list.id, list.title)}` to `onClick={() => handleCheckDuplicates(list.id, list.title)}`.

**Step 5: Reset new state in handleClose**

Add to `handleClose()`:
```typescript
setSelectedListId('');
setSelectedListTitle('');
setItemChecklist([]);
```

**Step 6: Update title for review step**

```typescript
const title = step === 'list'
  ? t('editor.transform.toTaskList')
  : step === 'review'
  ? t('editor.transform.duplicatesFound', { count: itemChecklist.filter(i => i.isDuplicate).length })
  : t('editor.transform.removeFromNote');
```

**Step 7: Verify frontend build**

Run: `cd frontend && npx tsc -b`
Expected: PASS

---

### Task 9: Version bump, changelog, and final build verification

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/data/changelog.ts`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/it.json`

**Step 1: Bump version**

In `frontend/package.json`, change version to `"1.6.5"`.

**Step 2: Add changelog entries**

In `frontend/src/data/changelog.ts`, add at the top of the array:
```typescript
{
  version: '1.6.5',
  date: '2026-02-26',
  entries: [
    { type: 'fix', titleKey: 'whatsNew.entries.sharingEmailFix' },
    { type: 'feature', titleKey: 'whatsNew.entries.sentInvitationsPanel' },
    { type: 'feature', titleKey: 'whatsNew.entries.smartMerge' },
    { type: 'improvement', titleKey: 'whatsNew.entries.sharingExpiry' },
  ],
},
```

**Step 3: Add whatsNew i18n keys**

In `en.json` under `"whatsNew.entries"`:
```json
"sharingEmailFix": "Fixed email invitation links not working",
"sentInvitationsPanel": "New panel to view, resend, and cancel sent invitations",
"smartMerge": "Smart duplicate detection when adding items to existing boards/task lists",
"sharingExpiry": "Configurable invitation expiry with on-read cleanup"
```

In `it.json` under `"whatsNew.entries"`:
```json
"sharingEmailFix": "Corretti i link di invito nelle email",
"sentInvitationsPanel": "Nuovo pannello per visualizzare, reinviare e annullare gli inviti inviati",
"smartMerge": "Rilevamento duplicati intelligente per aggiunta a board/liste esistenti",
"sharingExpiry": "Scadenza inviti configurabile con pulizia automatica"
```

**Step 4: Full build verification**

Run: `cd backend && npx tsc --noEmit`
Expected: PASS

Run: `cd frontend && npx tsc -b`
Expected: PASS

Run: `cd frontend && npm run build`
Expected: PASS (production build)
