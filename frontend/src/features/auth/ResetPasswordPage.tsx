
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { resetPassword } from '../../lib/api';

// Schema moved inside component to access t()

export default function ResetPasswordPage() {
  const { t } = useTranslation();

  const schema = z.object({
    password: z.string().min(6, t('auth.passwordLength')),
    confirmPassword: z.string(),
  }).refine((data) => data.password === data.confirmPassword, {
    message: t('auth.passwordMismatch'),
    path: ["confirmPassword"],
  });

  type FormData = z.infer<typeof schema>;

  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);
  const token = searchParams.get('token');

  const { register, handleSubmit, formState: { errors } } = useForm<FormData>({
    resolver: zodResolver(schema),
  });

  const onSubmit = async (data: FormData) => {
    if (!token) {
      toast.error(t('auth.invalidToken'));
      return;
    }

    setIsLoading(true);
    try {
      await resetPassword(token, data.password);

      toast.success(t('auth.resetSuccess'));
      navigate('/login');
    } catch (error: unknown) {
      const axiosErr = error as { response?: { data?: { message?: string } }; message?: string };
      const message = axiosErr.response?.data?.message || axiosErr.message || t('auth.resetFailed');
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <h2 className="text-xl font-semibold text-red-600">{t('auth.invalidTokenTitle')}</h2>
          <Button className="mt-4" onClick={() => navigate('/login')}>
            {t('auth.backToLogin')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-12 sm:px-6 lg:px-8 dark:bg-gray-900">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900">
            <Lock className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h2 className="mt-6 text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('auth.resetPasswordTitle')}
          </h2>
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('profile.newPassword')}</label>
              <Input
                type="password"
                {...register('password')}
                error={!!errors.password?.message}
              />
              {errors.password && (
                <p className="mt-1 text-sm text-red-500">{errors.password.message}</p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('profile.confirmPassword')}</label>
              <Input
                type="password"
                {...register('confirmPassword')}
                error={!!errors.confirmPassword?.message}
              />
              {errors.confirmPassword && (
                <p className="mt-1 text-sm text-red-500">{errors.confirmPassword.message}</p>
              )}
            </div>
          </div>

          <Button type="submit" className="w-full" isLoading={isLoading}>
            {t('auth.resetPasswordButton')}
          </Button>
        </form>
      </div>
    </div>
  );
}
