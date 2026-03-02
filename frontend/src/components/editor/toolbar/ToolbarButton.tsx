import clsx from 'clsx';

export interface ToolbarButtonProps {
  onClick: () => void;
  isActive?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  title: string;
}

export default function ToolbarButton({
  onClick,
  isActive = false,
  disabled = false,
  children,
  title
}: ToolbarButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={clsx(
        "p-2 sm:p-1.5 rounded transition-colors flex items-center justify-center min-w-[40px] min-h-[40px] md:min-w-[36px] md:min-h-[36px]",
        isActive
          ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-white"
          : "bg-transparent text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
        disabled && "opacity-50 cursor-not-allowed hover:bg-transparent hover:text-neutral-500 dark:hover:bg-transparent dark:hover:text-neutral-400"
      )}
    >
      {children}
    </button>
  );
}
