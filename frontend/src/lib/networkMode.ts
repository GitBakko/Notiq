/**
 * TanStack Query v5 defaults every mutation/query to `networkMode: 'online'`:
 * when `onlineManager.isOnline()` is false, `mutationFn`/`queryFn` is never
 * invoked at all — it just sits paused. That default is correct for calls
 * that hit the API directly, but Notiq is offline-first: many mutations only
 * write to Dexie and enqueue to `syncQueue` (see `frontend/src/lib/db.ts`),
 * with no network call in the function body. Under the default, those do
 * nothing while the browser reports offline — silently breaking the app's
 * core offline promise.
 *
 * Spread this into any `useMutation`/`useQuery` whose fn only touches Dexie
 * (writes to `db.*` and/or `db.syncQueue`, no `api.*` call in the function).
 * It is opt-in, not the global default, because 31 mutations in this app
 * *do* call the API directly and are correctly paused offline today (two of
 * them — `deleteCover`, `deleteAvatar` — would misbehave if forced to run
 * offline). Flipping the global default would silently change all of those.
 *
 * Exit path if this ever needs to invert: set `mutations.networkMode` (and
 * `queries.networkMode`) to `'always'` in `queryClient.ts`'s defaultOptions,
 * then give every network-only call site `{ networkMode: 'online' }` instead
 * of removing this constant.
 */
export const LOCAL_FIRST = { networkMode: 'always' } as const;
