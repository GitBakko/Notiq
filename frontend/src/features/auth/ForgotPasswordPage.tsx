
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link } from 'react-router-dom';
import { Mail, ArrowLeft } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { forgotPassword } from '../../lib/api';

const schema = z.object({
  email: z.string().email(), // Validation message handled by browser or default
});

type FormData = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [isSent, setIsSent] = useState(false);

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    setIsLoading(true);
    try {
      await forgotPassword(data.email);

      setIsSent(true);
      toast.success(t('auth.resetLinkSent'));
    } catch {
      toast.error(t('auth.resetLinkFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-neutral-950">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
            <Mail className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-neutral-900 dark:text-white">
            {t('auth.forgotPasswordTitle')}
          </h2>
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
            {t('auth.forgotPasswordDescription')}
          </p>
        </div>

        {isSent ? (
          <div className="rounded-md bg-green-50 p-4 dark:bg-green-900/30">
            <div className="flex">
              <div className="ml-3">
                <h3 className="text-sm font-medium text-green-800 dark:text-green-200">
                  {t('auth.checkEmailTitle')}
                </h3>
                <div className="mt-2 text-sm text-green-700 dark:text-green-300">
                  <p>
                    {t('auth.checkEmailDescription')}
                  </p>
                </div>
                <div className="mt-4">
                  <Link
                    to="/login"
                    className="text-sm font-medium text-green-600 hover:text-green-500 dark:text-green-400"
                  >
                    {t('auth.backToLogin')}
                  </Link>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">{t('auth.email')}</label>
              <Input
                type="email"
                {...register('email')}
                error={!!errors.email?.message}
                autoComplete="email"
              />
              {errors.email && (
                <p className="mt-1 text-sm text-red-500">{errors.email.message}</p>
              )}
            </div>

            <Button type="submit" className="w-full" isLoading={isLoading}>
              {t('auth.sendResetLink')}
            </Button>

            <div className="flex items-center justify-center">
              <Link
                to="/login"
                className="flex items-center gap-2 text-sm font-medium text-emerald-600 hover:text-emerald-500 dark:text-emerald-400"
              >
                <ArrowLeft size={16} />
                {t('auth.backToLogin')}
              </Link>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
