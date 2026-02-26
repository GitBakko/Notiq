# Sharing Improvements & Smart Merge Design

**Date:** 2026-02-26
**Status:** Approved
**Version target:** 1.6.5

## Summary

Two features + bugfixes:
1. Eliminate JWT token flow from sharing emails, replace with dashboard links
2. Add "Sent Invitations" panel to SharedWithMePage
3. Smart merge (duplicate detection) when transforming note items to existing kanban/task list
4. Fix unlocalized error messages, add configurable invitation expiry

## Context & Problems

- Email invitation acceptance broken in production (all entity types)
- TaskList and KanbanBoard sharing never generate JWT tokens (token=undefined in email links)
- Note/Notebook tokens expire after 7 days (hardcoded), no way to resend
- No UI to view sent invitations, resend, or cancel them
- When transforming note items to existing board/list, duplicates are added without detection
- Error messages on failed invitation acceptance are not localized

## Design Decisions

### 1. Eliminate Token Email Flow

**Approach:** Remove JWT tokens from sharing emails entirely. Emails become notifications with a direct link to the Shared With Me dashboard.

**Email link format:**
```
https://notiq.epartner.it/shared?tab={notes|notebooks|taskLists|kanbanBoards}&highlight={shareRecordId}
```

The `highlight` parameter (already supported by SharedWithMePage) auto-scrolls to the invitation where the user can Accept/Decline via the existing `respond-id` endpoint.

**Removed:**
- `respondToShare(token, action)` function in sharing.service.ts
- POST `/share/respond` endpoint in routes/sharing.ts
- RespondToShare.tsx frontend page and its route in App.tsx
- JWT token generation in shareNote(), shareNotebook()

**Unchanged:**
- POST `/share/respond-id` endpoint (dashboard acceptance)
- In-app notifications
- SharedWithMePage Accept/Decline buttons

### 2. Sent Invitations Panel

**Location:** SharedWithMePage, new toggle "Received" / "Sent" above existing tabs.

**Sent view** shows shares created by the current user, grouped by entity:
- Recipient name/email
- Status badge: PENDING (yellow) / ACCEPTED (green) / DECLINED (red)
- Send date, permission level
- Actions: Resend (PENDING), Cancel (PENDING), Revoke (ACCEPTED)

**New backend endpoints:**
- `GET /share/sent` — all shares created by user across all 4 entity types
- `POST /share/resend/:type/:id` — re-send notification email for a PENDING share

**Existing endpoints reused for cancel/revoke:**
- `DELETE /share/notes/:id/:userId` (and equivalent for notebooks, tasklists, kanbans)

**No Prisma migration needed** — all data available via existing models.

### 3. Smart Merge in Transformations

**When:** User selects an existing board/task list (not "Create new").

**Flow addition:**
- Kanban: Board → Column → **Review Duplicates** → Confirm Remove
- Task List: List → **Review Duplicates** → Confirm Remove

**Duplicate detection:** Exact title match, case-insensitive (`trim().toLowerCase()`).
- Kanban: compare against `card.title` in selected column
- Task List: compare against `item.text` in selected list

**If zero duplicates:** Skip review step entirely (same behavior as today).

**Review UI:**
- Checklist of all items
- New items: pre-checked with "New" badge
- Duplicate items: pre-unchecked with "Duplicate" warning badge
- User can toggle any checkbox manually
- Buttons: "Add selected only" (default) / "Add all"

**Data source:** Already loaded locally (useKanbanBoard, taskList.items). No backend changes.

### 4. Configurable Expiry & Localization Fix

**Expiry:** New SystemSetting `sharing.invitationExpiryDays` (default: 30).
- On-read check: when loading sent shares, mark PENDING older than N days as expired
- Show "Expires in X days" in Sent panel for PENDING invitations
- No cron job needed

**Localization:** Eliminated by removing RespondToShare.tsx. Verify respond-id flow uses i18n keys.

## Files Impacted

### Backend
| File | Changes |
|------|---------|
| `services/sharing.service.ts` | Remove token generation, remove respondToShare(), add getSentShares(), add resendShareInvitation() |
| `services/tasklist-sharing.service.ts` | Update email params (add shareId, type) |
| `services/email.service.ts` | Update SHARE_INVITATION template (remove Accept/Decline buttons, add dashboard link) |
| `routes/sharing.ts` | Remove POST /respond, add GET /sent, add POST /resend/:type/:id |

### Frontend
| File | Changes |
|------|---------|
| `features/sharing/SharedWithMePage.tsx` | Add Received/Sent toggle, Sent view with resend/cancel/revoke |
| `pages/RespondToShare.tsx` | DELETE (removed) |
| `App.tsx` | Remove /share/respond route |
| `components/editor/TransformToKanbanModal.tsx` | Add 'review' step with duplicate detection |
| `components/editor/TransformToTaskListModal.tsx` | Add 'review' step with duplicate detection |
| `locales/en.json` | New i18n keys for sent panel, merge UI |
| `locales/it.json` | Same |
| `data/changelog.ts` | v1.6.5 entries |
