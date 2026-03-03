import i18n from 'i18next';

/**
 * Extracts and translates the error message from an Axios error response.
 * If the backend sends an i18n key (e.g. 'errors.notes.notFound'),
 * it returns the translated string. Falls back to the provided key.
 */
export function getApiErrorMessage(
  error: unknown,
  fallbackKey = 'common.somethingWentWrong'
): string {
  const axiosErr = error as { response?: { data?: { message?: string } } };
  const message = axiosErr?.response?.data?.message;
  if (!message) return i18n.t(fallbackKey);
  return i18n.t(message);
}
