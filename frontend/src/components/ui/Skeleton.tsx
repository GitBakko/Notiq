import clsx from 'clsx';

interface SkeletonProps {
  className?: string;
  variant?: 'text' | 'circle' | 'card' | 'rect';
  width?: string;
  height?: string;
}

function SkeletonBase({ className, variant = 'text', width, height }: SkeletonProps) {
  return (
    <div
      className={clsx(
        'animate-pulse bg-gray-200 dark:bg-gray-700',
        variant === 'text' && 'h-4 rounded',
        variant === 'circle' && 'rounded-full',
        variant === 'card' && 'rounded-xl',
        variant === 'rect' && 'rounded-lg',
        className,
      )}
      style={{ width, height }}
    />
  );
}

/** Repeats N skeleton list items (title + subtitle + date) */
function SkeletonList({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div className={clsx('space-y-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-4 rounded-xl bg-white dark:bg-gray-800/50 space-y-2">
          <SkeletonBase variant="text" className="w-3/4 h-5" />
          <SkeletonBase variant="text" className="w-full h-3" />
          <SkeletonBase variant="text" className="w-1/2 h-3" />
          <SkeletonBase variant="text" className="w-1/4 h-3 mt-2" />
        </div>
      ))}
    </div>
  );
}

/** Repeats N skeleton cards in a responsive grid */
function SkeletonGrid({ count = 3, className }: { count?: number; className?: string }) {
  return (
    <div className={clsx('grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="p-4 rounded-xl bg-white dark:bg-gray-800/50 space-y-3">
          <SkeletonBase variant="text" className="w-2/3 h-5" />
          <SkeletonBase variant="text" className="w-full h-3" />
          <div className="flex items-center gap-2 mt-2">
            <SkeletonBase variant="circle" className="w-6 h-6" />
            <SkeletonBase variant="text" className="w-20 h-3" />
          </div>
        </div>
      ))}
    </div>
  );
}

const Skeleton = Object.assign(SkeletonBase, {
  List: SkeletonList,
  Grid: SkeletonGrid,
});

export default Skeleton;
