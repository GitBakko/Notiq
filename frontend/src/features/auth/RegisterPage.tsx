import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { useAuthStore } from '../../store/authStore';
import { Alert } from '../../components/ui/Alert';

export default function RegisterPage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api.post('/auth/register', { email, password, name });
      setAuth(res.data.user, res.data.token);
      navigate('/');
    } catch (err) {
      const error = err as AxiosError<{ message: string }>;
      const rawMessage = error.response?.data?.message || t('auth.registrationFailed');
      setError(rawMessage);
    }
  };

  // Helper to safely parse and display the error message
  const parseErrorMessage = (msg: string) => {
    try {
      // Check if it looks like a JSON array or object
      if (msg.trim().startsWith('[') || msg.trim().startsWith('{')) {
        const parsed = JSON.parse(msg);

        // Zod array errors: [{ "code": "...", "message": "..." }, ...]
        if (Array.isArray(parsed)) {
          return (
            <ul className="list-disc pl-5 space-y-1">
              {parsed.map((item, idx) => (
                <li key={idx}>
                  {t(item.message) || item.message}
                </li>
              ))}
            </ul>
          );
        }

        // Single object error
        if (typeof parsed === 'object' && parsed !== null) {
          return t(parsed.message) || parsed.message;
        }
      }

      // Check if it's a translation key (no spaces)
      if (!msg.includes(' ')) {
        return t(msg);
      }

      // Fallback for plain strings
      return t(msg); // Try translating anyway, just in case
    } catch (e) {
      // If parsing fails, just return the string as-is
      return t(msg);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-gray-900">
      <div className="w-full max-w-md space-y-8">
        <div>
          <h2 className="mt-6 text-center text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('auth.createAccountTitle')}
          </h2>
        </div>
        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="-space-y-px rounded-md shadow-sm">
            <div>
              <input
                type="text"
                className="relative block w-full rounded-t-md border-0 py-1.5 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:ring-gray-700 dark:placeholder:text-gray-500"
                placeholder={t('auth.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <input
                type="email"
                required
                className="relative block w-full border-0 py-1.5 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:ring-gray-700 dark:placeholder:text-gray-500"
                placeholder={t('auth.emailPlaceholder')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div>
              <input
                type="password"
                required
                className="relative block w-full rounded-b-md border-0 py-1.5 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:ring-gray-700 dark:placeholder:text-gray-500"
                placeholder={t('auth.passwordPlaceholder')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          {error && (
            <Alert variant="danger" title={t('common.error') || 'Error'}>
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
      </div>
    </div>
  );
}
