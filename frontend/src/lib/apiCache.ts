// Cache Workbox 'api-cache' (runtimeCaching dei GET /api/*).

/** Elimina l'intera cache 'api-cache'. */
export async function purgeApiCache(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    await caches.delete('api-cache');
  } catch {
    // cache non disponibile: niente da ripulire
  }
}

/** Rimuove dalla cache 'api-cache' le sole risposte /api/vault/* (solo i GET vi finiscono). */
export async function purgeVaultCache(): Promise<void> {
  try {
    if (typeof caches === 'undefined') return;
    const cache = await caches.open('api-cache');
    for (const req of await cache.keys()) {
      if (new URL(req.url).pathname.includes('/vault/')) await cache.delete(req);
    }
  } catch {
    // cache non disponibile: niente da ripulire
  }
}
