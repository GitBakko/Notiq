# Notiq Motion — QA Checklist (bullet-proof)

## Setup
- Run frontend: `cd frontend && npm install && npm run dev`

## Begin Thinking
- Click into TipTap editor: dot performs micro shift + scale, then settles.
- Create/open a note: dot animates once.
- Open command palette: dot animates once.
- Open AI chat: dot animates once.

## Ink Activation
- Stop interacting for >= 2s.
- Press a key: a 40ms micro “ink trail” appears ONCE.
- Keep typing: no repeated trails.
- Wait >=2s again, press a key: trail appears once again.

## Cognitive Idle State
- Stop interacting for >= 5s.
- Dot starts imperceptible breathing (scale up to 1.015 + opacity to 0.96).
- Move mouse / scroll / keydown: breathing stops immediately.

## Reduced motion
- Enable OS setting “Reduce motion”.
- Reload app:
  - No idle breathing.
  - No ink trail.
  - Begin Thinking is disabled or opacity-only (no transforms).

## Performance sanity
- No repeated event listeners on hot reload (check console if instrumented).
- No layout reflows caused by motion (only transform/opacity).

## Aesthetic sanity
- No glow.
- No bounce.
- No long fades.
