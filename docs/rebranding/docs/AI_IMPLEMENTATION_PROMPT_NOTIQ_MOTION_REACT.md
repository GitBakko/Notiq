# AI IMPLEMENTATION PROMPT — Notiq Motion System (React 19 / Vite 7 / TailwindCSS 3) — v1.0 FINAL

You are a senior frontend engineer specialized in product-grade motion (Apple Notes / Linear / Raycast style).
Implement the **Notiq Motion System** exactly as specified. Do NOT add extra animations.

The repository stack is:
- Frontend: **React 19, Vite 7, TypeScript, TailwindCSS 3**
- Editor: **TipTap v2**
- State: **Zustand**
- Data: **TanStack Query v5**
- E2E: **Playwright**

Your job: add a **centralized, testable, accessible** motion system that delivers:
1) **Begin Thinking**
2) **Ink Activation**
3) **Cognitive Idle State**

---

## 0) Non-negotiable constraints
- Motion must be quiet, minimal, elegant.
- No glow, no bounce, no elastic, no spring exaggerations.
- Animate only: `transform`, `opacity`.
- Use CSS variables for timings/amp; no magic numbers scattered.
- Respect `prefers-reduced-motion: reduce` (must disable non-essential motion).
- No DOM churn for Ink Activation (use pseudo-element / static child).
- Idle detection must be global and must not attach duplicate listeners.
- Everything goes through a **single source of truth** (module + hook + CSS).

---

## 1) Deliverables (files to create/modify)
Create these files inside `frontend/src/` (adjust if repo differs, but keep same separation):

### 1.1 Tokens
- `styles/notiq-motion.css`  (CSS variables + keyframes + classes)
- Ensure this stylesheet is imported once globally (e.g., in `main.tsx` or a global css entry).

### 1.2 Motion core (single source of truth)
- `lib/motion/notiqMotion.constants.ts`
- `lib/motion/notiqMotion.ts` (core singleton module, no React)
- `lib/motion/useNotiqMotion.ts` (React hook wrapper)
- `components/ui/NotiqDot.tsx` (render + class binding; reusable)

### 1.3 Integration touchpoints
Wire triggers in these feature areas (names may differ, locate equivalents):
- TipTap editor wrapper/component: on focus -> Begin Thinking; on first key after idle -> Ink Activation
- New note action/button: after creating/opening note -> Begin Thinking
- Command palette open: on open -> Begin Thinking
- AI chat open: on open -> Begin Thinking

### 1.4 Tests
Prefer **Vitest** (standard Vite). If already present, use existing setup:
- `lib/motion/notiqMotion.test.ts` (core logic)
- `lib/motion/useNotiqMotion.test.tsx` (hook behavior)

If Vitest not present, add minimal dev deps and config OR document why tests are skipped (only if impossible).

### 1.5 Docs
- Add/Update: `docs/motion.md` (already provided in this bundle). Keep in sync.

---

## 2) Motion tokens (MUST match)
Implement these CSS variables in `styles/notiq-motion.css`:

- `--notiq-ease-primary: cubic-bezier(0.22, 1, 0.36, 1)`
- `--notiq-dur-micro: 120ms`
- `--notiq-dur-settle: 80ms`
- `--notiq-dur-standard: 180ms`
- `--notiq-dur-layout: 260ms`
- `--notiq-dot-shift: 2px`
- `--notiq-dot-scale: 1.06`

Also implement:
- `--notiq-idle-timeout: 5000ms`
- `--notiq-typing-idle-threshold: 2000ms`
- `--notiq-ink-trail-len: 6px`
- `--notiq-ink-trail-opacity: 0.12`
- `--notiq-ink-trail-dur: 40ms`
- `--notiq-idle-breathe-period: 6000ms`
- `--notiq-idle-breathe-scale: 1.015`
- `--notiq-idle-breathe-opacity-min: 0.90`
- `--notiq-idle-breathe-opacity-max: 0.96`

---

## 3) CSS classes (authoritative contract)
Define these classes in `styles/notiq-motion.css`:

### 3.1 Begin Thinking
Base:
- `.notiq-dot` -> opacity 0.85; transition transform+opacity
Active:
- `.notiq-dot--active` -> translateX(var(--notiq-dot-shift)) scale(var(--notiq-dot-scale)); opacity 1

### 3.2 Ink Activation
- `.notiq-dot--ink` triggers a **single** 40ms trail animation.
Implementation requirement:
- use `::after` on `.notiq-dot` (preferred) or a static child span.
- no new DOM nodes per keystroke.

### 3.3 Cognitive Idle State
- `.notiq-dot--idle` applies an ultra-subtle breathing keyframe:
  - period: var(--notiq-idle-breathe-period)
  - scale: 1 -> var(--notiq-idle-breathe-scale) -> 1
  - opacity: min->max->min
  - easing: ease-in-out
- Must stop immediately upon activity.

### 3.4 Reduced motion
Add:
`@media (prefers-reduced-motion: reduce)`:
- disable keyframes + transitions (or degrade Begin Thinking to opacity-only).
- `.notiq-dot--idle` must not animate.
- `.notiq-dot--ink` must do nothing.

---

## 4) Core logic (notiqMotion.ts) — REQUIRED API
Implement a singleton module (no React) that manages global state.

### 4.1 Public API
- `init()` -> attaches global listeners once
- `destroy()` -> removes listeners
- `setEnabled(boolean)` -> feature flag master
- `setIdleEnabled(boolean)` -> allow disabling Cognitive Idle separately
- `triggerBeginThinking(target?: HTMLElement)` -> toggles `.notiq-dot--active` for ~200ms
- `triggerInk(target?: HTMLElement)` -> toggles `.notiq-dot--ink` for 40ms (once)
- `registerGlobalDot(el: HTMLElement | null)` -> stores global dot reference
- `getIsIdle()` -> boolean
- `subscribeIdle(cb: (idle: boolean) => void)` -> returns unsubscribe

### 4.2 Idle detection rules
- Idle if no activity for **5000ms**.
- Activity events: `mousemove`, `mousedown`, `keydown`, `scroll`, `touchstart`.
- On first activity after idle -> set idle false immediately, remove `.notiq-dot--idle` immediately.
- When idle becomes true -> add `.notiq-dot--idle` to global dot (only).

### 4.3 Typing-start detection for Ink Activation
- Track last activity timestamp.
- Ink triggers on first `keydown` if:
  - time since last activity >= **2000ms**
  - and ink is not currently “cooling down”.
- Cooldown: after triggering ink, ignore further ink triggers until another idle window occurs.

### 4.4 prefers-reduced-motion
- Detect once via `matchMedia('(prefers-reduced-motion: reduce)')`.
- If reduce motion is on: disable idle + ink and either disable BeginThinking or make it opacity-only.

---

## 5) React hook (useNotiqMotion.ts)
Implement:
- On app mount (likely in `App.tsx` or root layout): call `notiqMotion.init()` and `destroy()` on unmount.
- Expose:
  - `isIdle`
  - `triggerBeginThinking()`
  - `registerGlobalDot(ref)` helper

Prefer a hook + context if needed, but keep it simple and centralized.

---

## 6) NotiqDot component (NotiqDot.tsx)
Create a reusable component that renders the dot and registers it as the global dot.

Requirements:
- `forwardRef` optional
- Props:
  - `global?: boolean` (default true for header dot; if false, it can still animate locally)
  - `className?: string`
- Always includes base class `.notiq-dot`.
- If `global` true: registers element via `registerGlobalDot`.

---

## 7) Integration points (critical)
You MUST wire triggers where they matter:
- TipTap editor:
  - on focus: BeginThinking on global dot
  - on first key after idle >=2s: Ink Activation on global dot
- New note:
  - after note opens / editor focuses: BeginThinking
- Command palette open:
  - BeginThinking at open time
- AI chat open:
  - BeginThinking at open time

Do not add hover animations.

---

## 8) Feature flags
Implement simple flags (choose the existing pattern in repo; default on in dev):
- `VITE_ENABLE_MOTION=true`
- `VITE_ENABLE_IDLE_MOTION=true`

They should be read once at startup.

---

## 9) Definition of Done (DoD)
- BeginThinking works and always self-resets.
- Ink triggers only on typing-start after >=2s inactivity.
- Idle breathing starts after 5s and stops immediately on activity.
- Reduced-motion disables idle+ink (and degrades BeginThinking).
- No duplicated listeners.
- Tests cover: idle transitions, ink gating, beginThinking timer.

---

## 10) PR output
At the end provide:
- list of files changed
- 3-step “how to test manually”
- note about reduced-motion verification
