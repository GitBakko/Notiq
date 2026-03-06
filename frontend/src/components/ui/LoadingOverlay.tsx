import { Loader2 } from 'lucide-react';

interface LoadingOverlayProps {
  isVisible: boolean;
  message?: string;
}

export default function LoadingOverlay({ isVisible, message }: LoadingOverlayProps) {
  if (!isVisible) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white dark:bg-neutral-800 rounded-2xl p-8 shadow-2xl flex flex-col items-center gap-4 min-w-[200px]">
        <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
        {message && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300 text-center">{message}</p>
        )}
      </div>
    </div>
  );
}
