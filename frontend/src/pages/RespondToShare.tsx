import { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { CheckCircle, XCircle, Loader2 } from 'lucide-react';

export default function RespondToShare() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const action = searchParams.get('action');

  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token || !action || (action !== 'accept' && action !== 'decline')) {
      setStatus('error');
      setMessage(t('sharing.invalidParams'));
      return;
    }

    const processResponse = async () => {
      try {
        await api.post('/share/respond', { token, action });
        setStatus('success');
        setMessage(action === 'accept' ? t('sharing.acceptedRedirect') : t('sharing.declined'));

        if (action === 'accept') {
          setTimeout(() => {
            navigate('/shared');
          }, 2000);
        }
      } catch (err: any) {
        setStatus('error');
        setMessage(err.response?.data?.message || t('sharing.processFailed'));
      }
    };

    processResponse();
  }, [token, action, navigate, t]);

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="bg-white dark:bg-gray-800 p-8 rounded-lg shadow-lg max-w-md w-full text-center">
        {status === 'loading' && (
          <div className="flex flex-col items-center">
            <Loader2 className="w-12 h-12 text-emerald-500 animate-spin mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">{t('sharing.processing')}</h2>
          </div>
        )}

        {status === 'success' && (
          <div className="flex flex-col items-center">
            <CheckCircle className="w-12 h-12 text-emerald-500 mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">{t('common.success')}</h2>
            <p className="text-gray-600 dark:text-gray-300">{message}</p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col items-center">
            <XCircle className="w-12 h-12 text-red-500 mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">{t('common.error')}</h2>
            <p className="text-gray-600 dark:text-gray-300">{message}</p>
            <button
              onClick={() => navigate('/')}
              className="mt-4 px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700"
            >
              {t('common.goHome')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
