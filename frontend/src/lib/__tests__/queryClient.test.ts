import { describe, it, expect, beforeEach, vi } from 'vitest';

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
