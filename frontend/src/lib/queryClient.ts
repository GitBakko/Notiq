import { QueryClient, MutationCache } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '../utils/errorUtils';

/**
 * Global mutation error handler.
 *
 * Without this, a failed mutation produces no observable output at all:
 * no toast, no log, the UI just stays put and the user assumes it saved.
 *
 * Two deliberate exemptions:
 *  - 401: api.ts already refreshes the token, or logs out. A toast there is noise.
 *  - mutations that declare their own onError in useMutation({...}): they already
 *    show a specific message, so a second generic toast would be a duplicate.
 */
export function handleMutationError(
  error: unknown,
  mutation?: { options?: { onError?: unknown } },
): void {
  if (mutation?.options?.onError) return;

  const status = (error as { response?: { status?: number } })?.response?.status;
  if (status === 401) return;

  toast.error(getApiErrorMessage(error));
}

const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _onMutateResult, mutation) =>
      handleMutationError(error, mutation),
  }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 5, // 5 minutes
      retry: 1,
    },
  },
});

export default queryClient;
