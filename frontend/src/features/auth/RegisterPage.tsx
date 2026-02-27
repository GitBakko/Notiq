import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import api from '../../lib/api';
import { Alert } from '../../components/ui/Alert';

export default function RegisterPage() {

  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [invitationCode, setInvitationCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [invitationEnabled, setInvitationEnabled] = useState(false); // Default false until loaded
  const [isLoadingConfig, setIsLoadingConfig] = useState(true);
  const [isSuccess, setIsSuccess] = useState(false);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await api.get('/auth/config');
        setInvitationEnabled(res.data.invitationSystemEnabled);
      } catch (err) {
        console.error('Failed to load auth config', err);
        // Default to true or false? Safe to assume enabled if error?
        // Or false to avoid blocking?
        // Let's assume false if failed to be safe, or retry.
        setInvitationEnabled(true);
      } finally {
        setIsLoadingConfig(false);
      }
    };
    fetchConfig();
  }, []);

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = t('auth.errors.nameRequired');
    if (!email.trim()) errors.email = t('auth.errors.emailRequired');
    if (!password) errors.password = t('auth.errors.passwordRequired');
    if (invitationEnabled && !invitationCode.trim()) errors.invitationCode = t('auth.errors.invitationCodeRequired');
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!validate()) return;
    try {
      await api.post('/auth/register', {
        email,
        password,
        name,
        invitationCode: invitationEnabled ? invitationCode : undefined
      });
      // Correct flow: Show success message, do not login
      setIsSuccess(true);
    } catch (err) {
      const error = err as AxiosError<{ message: string }>;
      const rawMessage = error.response?.data?.message || t('auth.registrationFailed');
      setError(rawMessage);
    }
  };

  const parseErrorMessage = (msg: string) => {
    try {
      if (msg.trim().startsWith('[') || msg.trim().startsWith('{')) {
        const parsed = JSON.parse(msg);
        if (Array.isArray(parsed)) {
          return (
            <ul className="list-disc pl-5 space-y-1">
              {parsed.map((item, idx) => <li key={idx}>{t(item.message) || item.message}</li>)}
            </ul>
          );
        }
        if (typeof parsed === 'object' && parsed !== null) {
          return t(parsed.message) || parsed.message;
        }
      }
      if (!msg.includes(' ')) return t(msg);
      return t(msg);
    } catch {
      return t(msg);
    }
  };

  const clearFieldError = (field: string) => {
    setFieldErrors(prev => { const next = { ...prev }; delete next[field]; return next; });
  };

  if (isSuccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-gray-900">
        <div className="w-full max-w-md space-y-8 text-center">
          <h2 className="text-3xl font-bold tracking-tight text-emerald-600">
            {t('auth.registrationSuccess')}
          </h2>
          <p className="text-gray-600 dark:text-gray-300">
            {t('auth.checkEmailVerify')}
          </p>
          <div className="mt-6">
            <Link to="/login" className="font-medium text-emerald-600 hover:text-emerald-500">
              {t('auth.goToLogin')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-gray-900">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('auth.createAccountTitle')}
          </h2>
        </div>

        {isLoadingConfig ? (
          <div className="text-center">{t('common.loading')}</div>
        ) : (
          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            <div className="-space-y-px rounded-md shadow-sm">
              <div>
                <input
                  type="text"
                  className={clsx(
                    'relative block w-full rounded-t-md border-0 py-1.5 text-gray-900 ring-1 ring-inset placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500',
                    fieldErrors.name
                      ? 'ring-red-500 dark:ring-red-500'
                      : 'ring-gray-300 dark:ring-gray-700'
                  )}
                  placeholder={t('auth.namePlaceholder')}
                  value={name}
                  onChange={(e) => { setName(e.target.value); clearFieldError('name'); }}
                />
              </div>
              <div>
                <input
                  type="email"
                  required
                  className={clsx(
                    'relative block w-full border-0 py-1.5 text-gray-900 ring-1 ring-inset placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500',
                    fieldErrors.email
                      ? 'ring-red-500 dark:ring-red-500'
                      : 'ring-gray-300 dark:ring-gray-700'
                  )}
                  placeholder={t('auth.emailPlaceholder')}
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); clearFieldError('email'); }}
                />
              </div>
              <div>
                <input
                  type="password"
                  required
                  className={clsx(
                    'relative block w-full border-0 py-1.5 text-gray-900 ring-1 ring-inset placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500',
                    !invitationEnabled ? 'rounded-b-md' : '',
                    fieldErrors.password
                      ? 'ring-red-500 dark:ring-red-500'
                      : 'ring-gray-300 dark:ring-gray-700'
                  )}
                  placeholder={t('auth.passwordPlaceholder')}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); clearFieldError('password'); }}
                />
              </div>
              {invitationEnabled && (
                <div>
                  <input
                    type="text"
                    required
                    className={clsx(
                      'relative block w-full rounded-b-md border-0 py-1.5 text-gray-900 ring-1 ring-inset placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:placeholder:text-gray-500',
                      fieldErrors.invitationCode
                        ? 'ring-red-500 dark:ring-red-500'
                        : 'ring-gray-300 dark:ring-gray-700'
                    )}
                    placeholder={t('auth.invitationCode')}
                    value={invitationCode}
                    onChange={(e) => { setInvitationCode(e.target.value); clearFieldError('invitationCode'); }}
                  />
                </div>
              )}
            </div>

            {(fieldErrors.name || fieldErrors.email || fieldErrors.password || fieldErrors.invitationCode) && (
              <div className="mt-2 space-y-1">
                {fieldErrors.name && <p className="text-red-500 dark:text-red-400 text-xs">{fieldErrors.name}</p>}
                {fieldErrors.email && <p className="text-red-500 dark:text-red-400 text-xs">{fieldErrors.email}</p>}
                {fieldErrors.password && <p className="text-red-500 dark:text-red-400 text-xs">{fieldErrors.password}</p>}
                {fieldErrors.invitationCode && <p className="text-red-500 dark:text-red-400 text-xs">{fieldErrors.invitationCode}</p>}
              </div>
            )}

            {error && (
              <Alert variant="danger" title={t('common.error')}>
                {parseErrorMessage(error)}
              </Alert>
            )}

            <div>
              <button
                type="submit"
                className="group relative flex w-full justify-center rounded-md bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500"
              >
                {t('auth.signUp')}
              </button>
            </div>
            <div className="text-center text-sm">
              <Link to="/login" className="font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 dark:hover:text-emerald-400">
                {t('auth.hasAccount')}
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
