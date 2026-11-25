import { useEffect, useRef } from 'react';

// Best effort: svuota il debounce prima di chiusura/kill della scheda; scrive solo in locale.
export function useFlushOnHide(fn: () => void) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'hidden') fnRef.current(); };
    const onHide = () => fnRef.current();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);
}
