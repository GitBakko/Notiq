
import { useState, useEffect } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';

export default function VerifyEmailPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setErrorMsg('No token provided');
      return;
    }

    const verify = async () => {
      try {
        await api.post('/auth/verify-email', { token });
        setStatus('success');
      } catch (err: unknown) {
        setStatus('error');
        const axiosErr = err as { response?: { data?: { message?: string } } };
        setErrorMsg(axiosErr.response?.data?.message || 'Verification failed');
      }
    };

    verify();
  }, [token]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-neutral-950">
      <div className="w-full max-w-md space-y-8 text-center bg-white dark:bg-neutral-800 p-8 rounded-lg shadow-md">
        {status === 'verifying' && (
          <div>
            <h2 className="text-2xl font-bold dark:text-white">{t('auth.verifying')}</h2>
            <div className="mt-4 animate-spin rounded-full h-8 w-8 border-b-2 border-emerald-600 mx-auto"></div>
          </div>
        )}

        {status === 'success' && (
          <div>
            <h2 className="text-2xl font-bold text-emerald-600">{t('auth.emailVerified')}</h2>
            <p className="mt-2 text-neutral-600 dark:text-neutral-300">
              {t('auth.verificationSuccessBody')}
            </p>
            <div className="mt-6">
              <Link
                to="/login"
                className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-500"
              >
                {t('auth.goToLogin')}
              </Link>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div>
            <h2 className="text-2xl font-bold text-red-600">{t('auth.verificationFailed')}</h2>
            <p className="mt-2 text-neutral-600 dark:text-neutral-300">
              {errorMsg === 'Invalid or expired token' ? t('auth.invalidLink') : errorMsg}
            </p>
            <div className="mt-6">
              <Link
                to="/login"
                className="text-emerald-600 hover:text-emerald-500 font-medium"
              >
                {t('auth.backToLogin')}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
