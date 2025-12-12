import clsx from 'clsx';
import { AlertCircle, CheckCircle, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

interface AlertProps {
  variant?: 'success' | 'danger' | 'warning' | 'info';
  title?: string;
  children: ReactNode;
  className?: string;
}

const variants = {
  success: {
    container: 'bg-emerald-50 text-emerald-900 border-emerald-200 dark:bg-emerald-900/10 dark:text-emerald-200 dark:border-emerald-800',
    icon: CheckCircle,
    iconColor: 'text-emerald-600 dark:text-emerald-400',
  },
  danger: {
    container: 'bg-red-50 text-red-900 border-red-200 dark:bg-red-900/10 dark:text-red-200 dark:border-red-800',
    icon: XCircle,
    iconColor: 'text-red-600 dark:text-red-400',
  },
  warning: {
    container: 'bg-amber-50 text-amber-900 border-amber-200 dark:bg-amber-900/10 dark:text-amber-200 dark:border-amber-800',
    icon: AlertCircle,
    iconColor: 'text-amber-600 dark:text-amber-400',
  },
  info: {
    container: 'bg-blue-50 text-blue-900 border-blue-200 dark:bg-blue-900/10 dark:text-blue-200 dark:border-blue-800',
    icon: Info,
    iconColor: 'text-blue-600 dark:text-blue-400',
  },
};

export const Alert = ({ variant = 'info', title, children, className }: AlertProps) => {
  const style = variants[variant];
  const Icon = style.icon;

  return (
    <div className={clsx('rounded-md border p-4 shadow-sm', style.container, className)}>
      <div className="flex">
        <div className="flex-shrink-0">
          <Icon className={clsx('h-5 w-5', style.iconColor)} aria-hidden="true" />
        </div>
        <div className="ml-3 flex-1 md:flex md:justify-between">
          <div className="text-sm">
            {title && <h3 className="font-medium mb-1">{title}</h3>}
            <div className={clsx(title ? 'mt-1' : '')}>
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
