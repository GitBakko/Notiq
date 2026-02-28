import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';

export default function LoginPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);

  const validate = (): boolean => {
    const errors: Record<string, string> = {};
    if (!email.trim()) errors.email = t('auth.errors.emailRequired');
    if (!password) errors.password = t('auth.errors.passwordRequired');
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});
    if (!validate()) return;
    try {
      const res = await api.post('/auth/login', { email, password });
      setAuth(res.data.user, res.data.token);
      navigate('/');
    } catch (err) {
      const error = err as AxiosError<{ message: string }>;
      setError(error.response?.data?.message || t('auth.loginFailed'));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-neutral-950">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center">
          <div className="h-28 w-28 sm:h-32 sm:w-32 flex items-center justify-center mb-4">
            <img src="/logo-no-bg.png" alt={t('common.logoAlt')} className="h-full w-full object-contain" />
          </div>
          <h2 className="mt-2 text-center text-3xl font-bold tracking-tight text-neutral-900 dark:text-white">
            {t('auth.signInTitle')}
          </h2>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="space-y-3">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('auth.email')}</label>
              <input
                id="email"
                type="email"
                required
                className={clsx(
                  'relative block w-full rounded-lg border-0 py-1.5 text-neutral-900 ring-1 ring-inset placeholder:text-neutral-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-neutral-800 dark:text-white dark:placeholder:text-neutral-500',
                  fieldErrors.email
                    ? 'ring-red-500 dark:ring-red-500'
                    : 'ring-neutral-300 dark:ring-neutral-700'
                )}
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setFieldErrors(prev => { const next = { ...prev }; delete next.email; return next; });
                }}
              />
            </div>
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('auth.passwordPlaceholder')}</label>
              <input
                id="password"
                type="password"
                required
                className={clsx(
                  'relative block w-full rounded-lg border-0 py-1.5 text-neutral-900 ring-1 ring-inset placeholder:text-neutral-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-neutral-800 dark:text-white dark:placeholder:text-neutral-500',
                  fieldErrors.password
                    ? 'ring-red-500 dark:ring-red-500'
                    : 'ring-neutral-300 dark:ring-neutral-700'
                )}
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setFieldErrors(prev => { const next = { ...prev }; delete next.password; return next; });
                }}
              />
            </div>
          </div>

          {(fieldErrors.email || fieldErrors.password) && (
            <div className="mt-2 space-y-1">
              {fieldErrors.email && <p className="text-red-500 dark:text-red-400 text-sm">{fieldErrors.email}</p>}
              {fieldErrors.password && <p className="text-red-500 dark:text-red-400 text-sm">{fieldErrors.password}</p>}
            </div>
          )}

          {error && <div className="text-red-500 text-sm text-center">{error}</div>}

          <div>
            <button
              type="submit"
              className="group relative flex w-full justify-center rounded-md bg-emerald-600 px-3 py-3 h-12 text-base font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-500"
            >
              {t('auth.signIn')}
            </button>
          </div>
          <div className="flex items-center justify-center gap-2 text-sm mt-4">
            <Link to="/forgot-password" className="font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 dark:hover:text-emerald-400">
              {t('auth.forgotPasswordLink')}
            </Link>
            <span className="text-neutral-300 dark:text-neutral-600">|</span>
            <Link to="/register" className="font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 dark:hover:text-emerald-400">
              {t('auth.noAccount')}
            </Link>
            <span className="text-neutral-300 dark:text-neutral-600">|</span>
            <Link to="/request-invite" className="font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 dark:hover:text-emerald-400">
              {t('auth.requestInvite', 'Request Invite')}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
