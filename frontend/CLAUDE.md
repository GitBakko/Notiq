# Notiq — Frontend

Guida caricata quando si lavora sotto `frontend/`. I vincoli globali (AREE CRITICHE, stile di risposta) stanno nel `CLAUDE.md` di root.

## Mobile UI design

Notiq è una PWA installabile su mobile. Ogni componente UI nuovo o modificato deve rispettare queste linee guida.

### Principi generali

- **Mobile-first:** costruisci sempre dal breakpoint base verso l'alto. Non aggiungere stili desktop e poi overridare per mobile.
- **Touch targets:** ogni elemento interattivo (bottoni, link, checkbox) deve avere area minima `44×44px` (usa `min-h-[44px] min-w-[44px]`).
- **Safe areas:** su iPhone e Android con notch/gesture bar, usare `env(safe-area-inset-*)` via Tailwind. Verificare che `viewport-fit=cover` sia presente nel meta viewport del `index.html`.
- **No hover-only interactions:** ogni interazione affidata a `:hover` deve avere un equivalente touch (`:active`, tap, long-press).
- **Scroll naturale:** preferire `overflow-y-auto` con `-webkit-overflow-scrolling: touch` su container scrollabili. Evitare `overflow: hidden` su body in viste mobile.

### Breakpoint Tailwind usati in Notiq

| Breakpoint | Uso tipico |
|------------|------------|
| _(default)_ | Mobile portrait (< 640px) |
| `sm:` (640px) | Mobile landscape / tablet small |
| `md:` (768px) | Tablet |
| `lg:` (1024px) | Desktop |

### Pattern per componenti mobile

- **Sidebar/Navigation:** su mobile deve essere un drawer (slide-in da sinistra o bottom sheet) con overlay scuro. Non mostrare sidebar fissa su schermi `< md`.
- **Editor TipTap:** su mobile verificare che la toolbar non venga nascosta dalla tastiera virtuale. Se necessario, usare `visualViewport` API per riposizionarla. Evitare toolbar floating che interferisce con la selezione testo.
- **Modal e Sheet:** su mobile preferire bottom sheet (`translate-y` + drag handle visibile) invece di modal centrato. Usare `rounded-t-2xl` e `max-h-[90vh] overflow-y-auto`.
- **Liste note:** card full-width con padding contenuto. Swipe actions (es. delete, archive) tramite gesture touch; non affidarsi a pulsanti visibili sempre.
- **Kanban:** su mobile mostrare una colonna alla volta con navigazione swipe orizzontale. Non tentare layout multi-colonna su schermi `< md`.

### Dark mode su mobile

- Rispettare `prefers-color-scheme` via media query. Verificare che `uiStore` sincronizzi il tema con `window.matchMedia('(prefers-color-scheme: dark)')` all'init.
- Evitare sfondi puri `#000000` (OLED burn risk): preferire `zinc-950` o `neutral-900` per il tema dark.

### Performance mobile

- **Immagini:** `loading="lazy"` e `decoding="async"` su tutti gli `<img>`. Per allegati mostrare thumbnail compressa, non originale.
- **Animazioni:** usare solo `transform` e `opacity` (GPU-accelerated). Evitare animazioni su `height`, `width`, `top`, `left`.
- **Font:** non caricare più di 2 weight per font family. Usare `font-display: swap`.
- **Bundle:** ogni nuova dipendenza UI va valutata per impatto sul bundle (PWA su mobile ha vincoli di cache più stringenti).

### Accessibilità mobile

- `aria-label` obbligatorio su tutti i bottoni icon-only.
- Focus trap attivo su modal e drawer aperti (`focus-trap-react` o implementazione custom).
- `role="dialog"` + `aria-modal="true"` su ogni overlay.
- Testare con VoiceOver (iOS) e TalkBack (Android) sui flussi critici: login, creazione nota, accesso vault.

