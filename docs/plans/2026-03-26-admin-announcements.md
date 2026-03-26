# Admin Announcements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the SuperAdmin to broadcast rich-text announcements to all users, displayed as a sticky top banner in-app with push notification delivery and a history page.

**Architecture:** New `Announcement` + `AnnouncementDismissal` Prisma models. Admin creates announcements via rich-text editor in AdminPage (new tab). Active announcements render as a sticky banner in AppLayout. Dismissed announcements tracked per-user. History page in Settings. Push notifications sent to all subscribed users on creation.

**Tech Stack:** Prisma 7, Fastify 5, React 19, TailwindCSS 3, TipTap (rich text editor for admin), web-push

---

## Data Model

```prisma
enum AnnouncementCategory {
  MAINTENANCE
  FEATURE
  URGENT
}

model Announcement {
  id          String                @id @default(uuid())
  title       String
  content     String                // TipTap JSON (rich text)
  category    AnnouncementCategory
  isActive    Boolean               @default(true)
  createdById String
  createdBy   User                  @relation("AnnouncementCreator", fields: [createdById], references: [id], onDelete: Cascade)
  dismissals  AnnouncementDismissal[]
  createdAt   DateTime              @default(now())

  @@index([isActive, createdAt])
}

model AnnouncementDismissal {
  announcementId String
  announcement   Announcement @relation(fields: [announcementId], references: [id], onDelete: Cascade)
  userId         String
  user           User         @relation("AnnouncementDismissals", fields: [userId], references: [id], onDelete: Cascade)
  dismissedAt    DateTime     @default(now())

  @@id([announcementId, userId])
}
```

## File Structure

### Backend (create)
- `backend/src/services/announcement.service.ts` — CRUD + dismissal logic
- `backend/src/routes/announcements.ts` — REST endpoints

### Backend (modify)
- `backend/prisma/schema.prisma` — Add models + enum + User relations
- `backend/src/app.ts` — Register announcement routes

### Frontend (create)
- `frontend/src/features/announcements/AnnouncementBanner.tsx` — Sticky top banner
- `frontend/src/features/announcements/AnnouncementHistoryPage.tsx` — History (lazy-loaded)
- `frontend/src/features/announcements/announcementService.ts` — API calls
- `frontend/src/features/admin/tabs/AnnouncementsTab.tsx` — Admin CRUD tab

### Frontend (modify)
- `frontend/src/components/layout/AppLayout.tsx` — Render banner above content
- `frontend/src/features/admin/AdminPage.tsx` — Add Announcements tab
- `frontend/src/App.tsx` — Add history page route
- `frontend/src/components/layout/Sidebar.tsx` — Add history link in settings area (or use existing settings)
- `frontend/src/locales/en.json` + `it.json` — i18n keys
- `frontend/src/data/changelog.ts` — Version bump entry

---

## Phase 1: Backend (Tasks 1-4)

### Task 1: Prisma Schema + Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/20260326100000_add_announcements/migration.sql`

- [ ] Add `AnnouncementCategory` enum, `Announcement` model, `AnnouncementDismissal` model to schema
- [ ] Add User relations: `announcements Announcement[] @relation("AnnouncementCreator")` and `announcementDismissals AnnouncementDismissal[] @relation("AnnouncementDismissals")`
- [ ] Create migration SQL manually (project pattern — `CREATE TABLE`, `CREATE INDEX`, `ALTER TABLE ADD CONSTRAINT`)
- [ ] Apply migration: `npx prisma db execute --file` + `npx prisma migrate resolve --applied`
- [ ] Regenerate client: `npx prisma generate`
- [ ] Commit

### Task 2: Announcement Service

**Files:**
- Create: `backend/src/services/announcement.service.ts`

Functions:
- `createAnnouncement(createdById, { title, content, category })` — Create + send push to all subscribed users
- `getActiveAnnouncements(userId)` — Returns announcements not dismissed by this user, ordered by createdAt DESC
- `getAnnouncementHistory(page, limit)` — Paginated list of all announcements (for history page)
- `dismissAnnouncement(announcementId, userId)` — Create AnnouncementDismissal record
- `deactivateAnnouncement(announcementId)` — Set isActive = false (admin action)
- `deleteAnnouncement(announcementId)` — Hard delete (admin action)

Push notification on create:
```typescript
// Get all users with push subscriptions
const users = await prisma.user.findMany({
  where: { pushSubscriptions: { some: {} } },
  select: { id: true }
});
// Send push to each (fire-and-forget, don't block creation)
for (const user of users) {
  sendPushNotification(user.id, {
    title: `[${category}] ${title}`,
    body: extractPlainText(content).slice(0, 200),
    data: { type: 'ANNOUNCEMENT', announcementId: id }
  }).catch(() => {});
}
```

- [ ] Implement all functions
- [ ] Build: `npm run build`
- [ ] Commit

### Task 3: Announcement Routes

**Files:**
- Create: `backend/src/routes/announcements.ts`

Endpoints:
- `GET /api/announcements/active` — Auth required. Returns undismissed active announcements for current user
- `POST /api/announcements/:id/dismiss` — Auth required. Dismiss for current user
- `GET /api/announcements/history?page=1&limit=20` — Auth required. Paginated history
- `POST /api/admin/announcements` — SuperAdmin only. Create announcement
- `PUT /api/admin/announcements/:id/deactivate` — SuperAdmin only. Deactivate
- `DELETE /api/admin/announcements/:id` — SuperAdmin only. Delete

Validation: Zod schemas for create (title: string, content: string, category: enum)

- [ ] Implement route plugin with Zod validation
- [ ] Register in `app.ts`: public routes at `/api/announcements`, admin routes at `/api/admin/announcements`
- [ ] Build: `npm run build`
- [ ] Commit

### Task 4: Backend Tests

**Files:**
- Create: `backend/src/services/__tests__/announcement.service.test.ts`

- [ ] Test: createAnnouncement creates record and triggers push
- [ ] Test: getActiveAnnouncements excludes dismissed
- [ ] Test: dismissAnnouncement creates dismissal record
- [ ] Test: deactivateAnnouncement sets isActive false
- [ ] Test: getAnnouncementHistory returns paginated results
- [ ] Run: `npx vitest run src/services/__tests__/announcement.service.test.ts`
- [ ] Commit

---

## Phase 2: Frontend (Tasks 5-9)

### Task 5: Announcement Service + API

**Files:**
- Create: `frontend/src/features/announcements/announcementService.ts`

```typescript
export const getActiveAnnouncements = () => api.get<Announcement[]>('/announcements/active');
export const dismissAnnouncement = (id: string) => api.post(`/announcements/${id}/dismiss`);
export const getAnnouncementHistory = (page: number) => api.get<{ data: Announcement[], total: number }>('/announcements/history', { params: { page } });
// Admin
export const createAnnouncement = (data: CreateAnnouncementInput) => api.post('/admin/announcements', data);
export const deactivateAnnouncement = (id: string) => api.put(`/admin/announcements/${id}/deactivate`);
export const deleteAnnouncement = (id: string) => api.delete(`/admin/announcements/${id}`);
```

- [ ] Implement service + TypeScript interfaces
- [ ] Type-check: `npx tsc -b --noEmit`
- [ ] Commit

### Task 6: Announcement Banner

**Files:**
- Create: `frontend/src/features/announcements/AnnouncementBanner.tsx`
- Modify: `frontend/src/components/layout/AppLayout.tsx`

Banner design:
- Sticky top bar above everything (z-40)
- Category-based colors: URGENT = red, MAINTENANCE = amber, FEATURE = emerald
- Left: category icon (AlertTriangle / Wrench / Sparkles) + title (bold) + truncated content
- Right: "View" link (→ history page) + dismiss X button
- Stacks multiple announcements vertically (rare case)
- Renders rich text content as HTML (TipTap JSON → HTML or just use dangerouslySetInnerHTML with sanitized content)
- Dark mode variants
- Mobile: full-width, compact layout

Query pattern:
```typescript
const { data: announcements } = useQuery({
  queryKey: ['announcements', 'active'],
  queryFn: () => getActiveAnnouncements().then(r => r.data),
  refetchInterval: 5 * 60 * 1000, // Check every 5 min
});
```

Integration in AppLayout:
```tsx
<div className="flex h-screen ...">
  <AnnouncementBanner />  {/* Above sidebar + content */}
  <Sidebar />
  <main>...</main>
</div>
```

- [ ] Implement AnnouncementBanner component with category colors, dismiss logic, dark mode
- [ ] Integrate into AppLayout (render above content area)
- [ ] Type-check + visual test
- [ ] Commit

### Task 7: Announcement History Page

**Files:**
- Create: `frontend/src/features/announcements/AnnouncementHistoryPage.tsx`
- Modify: `frontend/src/App.tsx` — Add lazy route

UI pattern (similar to WhatsNewPage):
- Collapsible announcement cards
- Category badge (color-coded)
- Date + "by Admin Name"
- Rich text content rendered
- Pagination at bottom
- Empty state

Route: `/announcements` (lazy-loaded)

- [ ] Implement page with pagination, category badges, rich text rendering
- [ ] Add route in App.tsx
- [ ] Add sidebar link or settings link
- [ ] Commit

### Task 8: Admin Announcements Tab

**Files:**
- Create: `frontend/src/features/admin/tabs/AnnouncementsTab.tsx`
- Modify: `frontend/src/features/admin/AdminPage.tsx` — Add tab

Admin UI:
- List of all announcements (active first, then inactive)
- "New Announcement" button → modal with:
  - Title input
  - Category select (MAINTENANCE / FEATURE / URGENT)
  - Rich text editor (TipTap minimal — bold, italic, link, list)
  - Preview
  - "Publish" button
- Each announcement card: title, category badge, date, active/inactive status, deactivate/delete buttons
- Confirmation dialog before delete

- [ ] Implement AnnouncementsTab with list + create modal + TipTap editor
- [ ] Add to AdminPage TABS array with Megaphone icon
- [ ] Type-check
- [ ] Commit

### Task 9: i18n + Changelog + Final Polish

**Files:**
- Modify: `frontend/src/locales/en.json` + `it.json`
- Modify: `frontend/src/data/changelog.ts`

i18n keys needed:
```json
{
  "announcements": {
    "title": "Announcements",
    "history": "Announcement History",
    "noAnnouncements": "No announcements",
    "dismiss": "Dismiss",
    "viewAll": "View all",
    "create": "New Announcement",
    "titleLabel": "Title",
    "categoryLabel": "Category",
    "contentLabel": "Content",
    "publish": "Publish",
    "deactivate": "Deactivate",
    "deleteConfirm": "Are you sure you want to delete this announcement?",
    "published": "Announcement published",
    "dismissed": "Announcement dismissed",
    "categories": {
      "MAINTENANCE": "Maintenance",
      "FEATURE": "New Feature",
      "URGENT": "Urgent"
    }
  }
}
```

- [ ] Add all i18n keys to en.json and it.json
- [ ] Add changelog entry
- [ ] Full build test: backend + frontend
- [ ] Commit
