import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient, MutationObserver, onlineManager } from '@tanstack/react-query';
import { LOCAL_FIRST } from '../networkMode';

// errorUtils importa `i18n from 'i18next'` e chiama i18n.t(chiave).
// Restituendo la chiave verbatim possiamo asserire sul messaggio esatto.
vi.mock('i18next', () => ({
  default: { t: (key: string) => key },
}));

vi.mock('react-hot-toast', () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

import toast from 'react-hot-toast';
import { handleMutationError } from '../queryClient';

function axiosError(status: number, message?: string) {
  return { response: { status, data: message ? { message } : {} } };
}

describe('handleMutationError', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('toasts the translated server message on a 403', () => {
    handleMutationError(axiosError(403, 'errors.kanban.ownerOnly'));
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith('errors.kanban.ownerOnly');
  });

  it('falls back to common.somethingWentWrong when the response has no message', () => {
    handleMutationError(axiosError(500));
    expect(toast.error).toHaveBeenCalledWith('common.somethingWentWrong');
  });

  it('stays silent on 401 (api.ts already refreshes the token or logs out)', () => {
    handleMutationError(axiosError(401, 'errors.common.accessDenied'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stays silent when the mutation declares its own onError', () => {
    handleMutationError(axiosError(400, 'errors.kanban.columnHasCards'), {
      options: { onError: () => {} },
    });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts when the mutation has options but no onError', () => {
    handleMutationError(axiosError(400, 'errors.kanban.columnHasCards'), {
      options: {},
    });
    expect(toast.error).toHaveBeenCalledWith('errors.kanban.columnHasCards');
  });

  it('toasts the fallback on a network error with no response at all', () => {
    handleMutationError(new Error('Network Error'));
    expect(toast.error).toHaveBeenCalledWith('common.somethingWentWrong');
  });
});

// These two pin the actual runtime behaviour (does mutationFn run while
// offline?), not the config shape — asserting on `networkMode` alone would
// be tautological. Each test builds its own throwaway QueryClient: the
// imported `queryClient` singleton is never mounted in a unit test, so its
// mutationCache is never wired to onlineManager's `online` event and a
// paused mutation on it would stay pending forever, in a cache this whole
// file shares across tests.
describe('LOCAL_FIRST networkMode', () => {
  afterEach(() => {
    // Global singleton (module-level in query-core) — reset regardless of
    // pass/fail so it doesn't leak into other test files.
    onlineManager.setOnline(true);
  });

  it('without LOCAL_FIRST: mutationFn never runs while offline, and the mutation is paused', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient();
    const mutationFn = vi.fn().mockResolvedValue('ok');
    const observer = new MutationObserver(client, { mutationFn });

    // Intentionally not awaited: under the default 'online' networkMode
    // this promise never settles while offline (that's the bug). Awaiting
    // it would hang the test forever.
    void observer.mutate(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(mutationFn).not.toHaveBeenCalled();
    expect(observer.getCurrentResult().isPaused).toBe(true);
  });

  it('with LOCAL_FIRST: mutationFn runs immediately while offline', async () => {
    onlineManager.setOnline(false);
    const client = new QueryClient();
    const mutationFn = vi.fn().mockResolvedValue('ok');
    const observer = new MutationObserver(client, { mutationFn, ...LOCAL_FIRST });

    await observer.mutate(undefined);

    expect(mutationFn).toHaveBeenCalledTimes(1);
    expect(observer.getCurrentResult().isPaused).toBe(false);
  });
});
