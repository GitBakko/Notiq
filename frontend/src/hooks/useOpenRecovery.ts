import { useCallback, useEffect, useRef, useState } from 'react';
import { getKeyring, type OpenRecovery } from '../lib/vaultApi';
import { useAuthStore } from '../store/authStore';

const REFRESH_MS = 15 * 60_000; // GET /keyring: limite 60/min per utente, 15 min + focus sta largamente sotto

/**
 * Recupero vault aperto sull'account (GET /api/vault/keyring -> openRecovery). Rilegge al mount, al focus, quando la
 * scheda torna visibile e ogni 15 min. Su errore (rete, 503) tiene l'ultimo valore: un banner non sparisce per un blip.
 * Vale solo l'ultima richiesta partita (e solo per l'utente corrente): una risposta superata viene scartata.
 */
export function useOpenRecovery() {
  const userId = useAuthStore((s) => s.user?.id);
  const [state, setState] = useState<{ userId: string; value: OpenRecovery | null } | null>(null);
  const seq = useRef(0); // numero dell'ultima richiesta partita; le risposte con numero minore sono superate
  const pending = useRef(0); // numero della richiesta in volo (0 = nessuna)

  const currentUser = useRef(userId); // utente corrente: un refresh creato per un altro utente non deve toccare seq ne' stato

  // refresh() esplicito (es. dopo un annullo) parte sempre: nessuna risposta partita prima puo' superarlo
  const refresh = useCallback(async () => {
    if (!userId || currentUser.current !== userId) return;
    const my = ++seq.current;
    pending.current = my;
    try {
      const kr = await getKeyring<{ openRecovery?: OpenRecovery | null }>();
      if (my === seq.current && currentUser.current === userId) setState({ userId, value: kr.openRecovery ?? null });
    } catch {
      // tiene l'ultimo valore
    } finally {
      if (pending.current === my) pending.current = 0;
    }
  }, [userId]);

  // annullo riuscito: toglie subito il valore locale (anche se il refresh di conferma poi fallisce) e scarta le GET in volo
  const markCancelled = useCallback((id: string) => {
    seq.current++;
    setState((s) => (s?.value?.id === id ? { ...s, value: null } : s));
  }, []);

  useEffect(() => {
    currentUser.current = userId;
    if (!userId) return;
    // gli eventi ravvicinati (focus + visibilitychange) si accodano alla richiesta gia' in volo
    const soft = () => {
      if (!pending.current) void refresh();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') soft();
    };
    void refresh();
    window.addEventListener('focus', soft);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(soft, REFRESH_MS);
    return () => {
      window.removeEventListener('focus', soft);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- contatore, non un nodo DOM: serve il valore corrente
      seq.current++; // scarta le risposte dell'utente uscente
      pending.current = 0;
    };
  }, [userId, refresh]);

  return { openRecovery: userId && state?.userId === userId ? state.value : null, refresh, markCancelled };
}
