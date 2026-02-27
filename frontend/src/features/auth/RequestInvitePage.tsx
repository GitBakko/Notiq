import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../lib/api';
import { Mail, CheckCircle, ArrowLeft } from 'lucide-react';

export default function RequestInvitePage() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (honeypot) return; // Silently fail bots

    setIsSubmitting(true);
    setError('');

    try {
      await api.post('/auth/request', { email, honeypot }); // Public endpoint
      setIsSuccess(true);
    } catch (e: unknown) {
      // Even if it fails (e.g. rate limit), we might want to show success or a generic message to avoid enumeration,
      // but for UX we'll show a friendly error if it's a specific "limit reached" one, otherwise generic.
      // For security, usually better to say "If valid, we sent it", but here it's a request to *admin*.
      // So we just say "Request received".
      // But if API throws 429, we should tell them.
      const axiosErr = e as { response?: { status?: number } };
      if (axiosErr.response?.status === 429) {
        setError(t('auth.rateLimitExceeded', 'Too many requests. Please try again later.'));
      } else {
        // Assume success for all other errors to prevent email enumeration or leakage
        setIsSuccess(true);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSuccess) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-gray-900">
        <div className="w-full max-w-md space-y-8 text-center animate-in fade-in zoom-in duration-500">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
            <CheckCircle className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('auth.requestReceived', 'Request Received')}
          </h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            {t('auth.requestReceivedDesc', 'We have received your request. Using the email provided, we will notify you once your invitation is approved.')}
          </p>
          <div className="mt-8">
            <Link to="/login" className="text-emerald-600 hover:text-emerald-500 font-medium flex items-center justify-center gap-2">
              <ArrowLeft size={16} /> {t('auth.backToLogin', 'Back to Login')}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-gray-900">
      <div className="w-full max-w-md space-y-8">
        <div className="flex flex-col items-center">
          <div className="h-20 w-20 flex items-center justify-center mb-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm">
            <Mail className="h-10 w-10 text-emerald-600" />
          </div>
          <h2 className="mt-2 text-center text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('auth.requestInvite', 'Request an Invitation')}
          </h2>
          <p className="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
            {t('auth.requestInviteSub', 'Join Notiq to organize your life.')}
          </p>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
          <div className="rounded-md shadow-sm">
            <div>
              <label htmlFor="email-address" className="sr-only">
                {t('auth.email')}
              </label>
              <input
                id="email-address"
                name="email"
                type="email"
                autoComplete="email"
                required
                className="relative block w-full rounded-md border-0 py-2.5 text-gray-900 ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:z-10 focus:ring-2 focus:ring-inset focus:ring-emerald-600 sm:text-sm sm:leading-6 px-3 dark:bg-gray-800 dark:text-white dark:ring-gray-700 dark:placeholder:text-gray-500 shadow-sm"
                placeholder={t('auth.emailPlaceholder', 'Email address')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {/* Honeypot field - hidden */}
            <div style={{ display: 'none' }}>
              <input
                type="text"
                name="website_url_hp"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
              />
            </div>
          </div>

          {error && <div className="text-red-500 text-sm text-center bg-red-50 dark:bg-red-900/20 p-2 rounded-md border border-red-100 dark:border-red-900">{error}</div>}

          <div>
            <button
              type="submit"
              disabled={isSubmitting}
              className="group relative flex w-full justify-center rounded-md bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-600 disabled:opacity-70 disabled:cursor-not-allowed transition-all shadow-md hover:shadow-lg"
            >
              {isSubmitting ? (
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {t('common.sending', 'Sending...')}
                </div>
              ) : (
                t('auth.submitRequest', 'Submit Request')
              )}
            </button>
          </div>

          <div className="text-center mt-4">
            <Link to="/login" className="text-sm font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-500 dark:hover:text-emerald-400">
              {t('auth.backToLogin', 'Back to Login')}
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
