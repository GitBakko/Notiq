// Reference-only (do not drop-in blindly).
// This file illustrates the intended API surface for the motion singleton.

export type IdleSubscriber = (idle: boolean) => void;

export const notiqMotion = (() => {
  let enabled = true;
  let idleEnabled = true;
  let reduced = false;

  let globalDot: HTMLElement | null = null;
  let idle = false;

  let idleTimer: number | null = null;
  let lastActivity = Date.now();
  let inkArmed = true;

  const subs = new Set<IdleSubscriber>();

  const CLS_ACTIVE = 'notiq-dot--active';
  const CLS_INK = 'notiq-dot--ink';
  const CLS_IDLE = 'notiq-dot--idle';

  const IDLE_TIMEOUT = 5000;
  const TYPING_IDLE_THRESHOLD = 2000;

  const notify = () => subs.forEach(cb => cb(idle));

  function setReducedMotion(v: boolean) {
    reduced = v;
  }

  function registerGlobalDot(el: HTMLElement | null) {
    globalDot = el;
  }

  function setIdle(idleNext: boolean) {
    if (idle === idleNext) return;
    idle = idleNext;
    if (globalDot) {
      globalDot.classList.toggle(CLS_IDLE, idle && enabled && idleEnabled && !reduced);
    }
    if (!idle) inkArmed = true;
    notify();
  }

  function scheduleIdle() {
    if (idleTimer) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => setIdle(true), IDLE_TIMEOUT);
  }

  function onActivity() {
    lastActivity = Date.now();
    if (idle) setIdle(false);
    scheduleIdle();
  }

  function onKeydown() {
    const now = Date.now();
    const since = now - lastActivity;
    onActivity();

    if (!enabled || reduced) return;
    if (since >= TYPING_IDLE_THRESHOLD && inkArmed) {
      inkArmed = false;
      triggerInk(globalDot ?? undefined);
    }
  }

  function init() {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    mq.addEventListener?.('change', e => setReducedMotion(e.matches));

    const events: Array<[keyof WindowEventMap, any]> = [
      ['mousemove', onActivity],
      ['mousedown', onActivity],
      ['scroll', onActivity],
      ['touchstart', onActivity],
      ['keydown', onKeydown],
    ];
    events.forEach(([t, h]) => window.addEventListener(t, h, { passive: true } as any));
    scheduleIdle();
  }

  function destroy() {
    // remove listeners (omitted in reference)
    if (idleTimer) window.clearTimeout(idleTimer);
  }

  function setEnabled(v: boolean) {
    enabled = v;
    if (!enabled && globalDot) {
      globalDot.classList.remove(CLS_ACTIVE, CLS_INK, CLS_IDLE);
    }
  }

  function setIdleEnabled(v: boolean) {
    idleEnabled = v;
    if (!idleEnabled && globalDot) globalDot.classList.remove(CLS_IDLE);
  }

  function triggerBeginThinking(target?: HTMLElement) {
    const el = target ?? globalDot;
    if (!el || !enabled) return;
    el.classList.add(CLS_ACTIVE);
    window.setTimeout(() => el.classList.remove(CLS_ACTIVE), 200);
  }

  function triggerInk(target?: HTMLElement) {
    const el = target ?? globalDot;
    if (!el || !enabled || reduced) return;
    el.classList.add(CLS_INK);
    window.setTimeout(() => el.classList.remove(CLS_INK), 60);
  }

  function getIsIdle() {
    return idle;
  }

  function subscribeIdle(cb: IdleSubscriber) {
    subs.add(cb);
    return () => subs.delete(cb);
  }

  return {
    init,
    destroy,
    setEnabled,
    setIdleEnabled,
    registerGlobalDot,
    triggerBeginThinking,
    triggerInk,
    getIsIdle,
    subscribeIdle,
  };
})();
