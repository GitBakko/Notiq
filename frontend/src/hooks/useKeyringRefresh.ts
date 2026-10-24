import { useEffect } from 'react';
import { useVaultStore } from '../store/vaultStore';

const REFRESH_MS = 30_000; // GET /keyring: limite 60/min per utente, una chiamata ogni 30 s per scheda sta largamente sotto

/**
 * J.6: con lo sblocco offline attivo, un contatto online allinea la cache del keyring (un cambio PIN fatto da un altro
 * dispositivo deve togliere validita' al vecchio PIN offline). Al mount, all'evento online e ogni 30 s: una scheda
 * aperta a lungo non resta con la cache vecchia. Import dinamico: vaultSession non entra nel chunk principale.
 */
export function useKeyringRefresh(userId: string | undefined) {
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (!navigator.onLine || !useVaultStore.getState().byUser[userId]?.offlineUnlock) return;
      import('../lib/vaultSession').then((m) => m.refreshKeyringCache(userId)).catch(() => {});
    };
    refresh();
    window.addEventListener('online', refresh);
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      window.removeEventListener('online', refresh);
      clearInterval(timer);
    };
  }, [userId]);
}
