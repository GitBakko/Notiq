# Notiq — Motion Specification v1.0 (Product-grade)

> Target stack (from repo): **React 19 + Vite 7 + TailwindCSS 3 + TypeScript**.  
> This spec defines a single, coherent motion language for Notiq.
> Motion must feel *editorial, quiet, precise*—never decorative.

## Core philosophy
- Motion reduces cognitive friction; it does not add “personality” through gimmicks.
- If motion attracts attention, it is wrong.
- Prefer micro-feedback over transitions.
- Animate only `transform` and `opacity`.

## Timing & easing
**Durations**
- micro feedback: **80–140ms**
- state transition: **160–220ms**
- layout change: **max 280ms**
- anything > 300ms is forbidden.

**Primary easing**
- `cubic-bezier(0.22, 1, 0.36, 1)`

Forbidden: bounce, elastic, exaggerated spring, long fades.

## Signature interaction: Begin Thinking (the Dot)
**Meaning**
- dot = active thought / cursor / idea-in-motion.

**Trigger points**
- Editor focus (TipTap)
- New note action
- Command palette open
- AI chat open (per-note assistant)

**Behavior**
- translateX(+2px)
- scale(1 → 1.06)
- opacity(.85 → 1)
- settle back within ~200ms total.

## Ink Activation (Typing Start)
**Trigger**
- first keystroke after ≥ **2s** of inactivity (idle window)

**Behavior**
- dot emits an ultra-brief “ink trail”
- length: 6px
- opacity: 0.12
- duration: 40ms
- implemented via pseudo-element (no DOM churn)

## Cognitive Idle State (Final Level)
**Definition of idle**
- no user activity for **5s** (mousemove/scroll/keydown/touch)

**Target**
- apply only to the **global dot** (or a single header indicator), never to the whole layout.

**Breathing**
- period: 6000ms
- scale: 1 → 1.015 → 1
- opacity: 0.90 → 0.96 → 0.90
- easing: ease-in-out
- stop immediately on user input

## Accessibility
Respect `prefers-reduced-motion: reduce`:
- disable idle breathing + ink trail
- Begin Thinking may degrade to opacity-only (or no motion).

## Where NOT to use motion
- global navigation hover effects
- decorative pulses
- parallax
- continuous looping animations

## Verification checklist (manual QA)
1. Focus editor: dot animates (micro shift + scale) then settles.
2. Wait 5s: idle breathing begins (barely visible).
3. Any movement/key press: idle breathing stops immediately.
4. Wait ≥2s, type: a 40ms micro trail appears once.
5. With reduced-motion enabled: no breathing/trail; minimal/no Begin Thinking.
