# Notiq — Brand System & Usage Prompt (v3)

This folder contains the official visual identity and implementation assets for Notiq.

## Brand Essence
Notiq is not a notes app — it is a thinking instrument.

Design principles:
- Precision over decoration
- Silence over visual noise
- Writing as cognition
- Minimalism with intent

Symbol meaning:
- Continuous "N" stroke → structured knowledge
- Stylus cut → act of writing
- Forward dot → active thought / cursor in motion

---

## Optical Design System

The logo follows an 8pt optical grid:
- Stroke weight balanced optically (not mathematically)
- Diagonal visually compensated (+3% thickness perception)
- Dot slightly advanced to create forward momentum

Safe area:
Minimum padding = 24px or 1× dot diameter.

Never:
✘ add glow
✘ apply gradients
✘ rotate symbol
✘ place on busy textures

---

## Assets

### Logos
- notiq-symbol.svg → MASTER
- notiq-symbol-1024.png → marketing
- notiq-symbol-512.png → app icon base
- notiq-symbol-256.png → UI usage

### Micro Icon (16px optimized)
- notiq-symbol-micro.svg

This version is manually simplified for favicon readability.
Do NOT auto-scale the master SVG below 24px.

---

### Favicons & PWA
Use provided PNG sizes and favicon.ico.

Example manifest:

{
  "icons": [
    { "src": "/favicon_192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/favicon_512.png", "sizes": "512x512", "type": "image/png", "purpose": "any maskable" }
  ]
}

---

### Backgrounds
Logo intentionally excluded.

Use for:
- login
- onboarding
- dashboard empty states

---

## Motion Hint (optional)
Recommended micro‑interaction:

On focus:
dot moves +2px horizontally in 120ms (ease-out).
Suggests beginning of writing.

---

## Design Tokens
See tokens.json for color + spacing integration.

---

## Tone
Quiet.
Editorial.
Professional.
Timeless.

Notiq should feel like a precision notebook — not a productivity toy.

---

## Motion System
See `docs/motion.md` and `docs/AI_IMPLEMENTATION_PROMPT_NOTIQ_MOTION_REACT.md` for the official product-grade motion specification and AI-guided implementation steps.
