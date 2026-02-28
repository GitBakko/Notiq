import { useState } from 'react';
import clsx from 'clsx';

interface TableSelectorProps {
  onSelect: (rows: number, cols: number) => void;
}

export default function TableSelector({ onSelect }: TableSelectorProps) {
  const [hovered, setHovered] = useState({ rows: 0, cols: 0 });

  const MAX_ROWS = 10;
  const MAX_COLS = 10;

  return (
    <div className="p-2">
      <div className="mb-2 text-xs text-neutral-500 dark:text-neutral-400 text-center">
        {hovered.rows > 0 ? `${hovered.cols} x ${hovered.rows}` : 'Insert Table'}
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${MAX_COLS}, minmax(0, 1fr))` }}
        onMouseLeave={() => setHovered({ rows: 0, cols: 0 })}
      >
        {Array.from({ length: MAX_ROWS }).map((_, rowIndex) => (
          Array.from({ length: MAX_COLS }).map((_, colIndex) => {
            const r = rowIndex + 1;
            const c = colIndex + 1;
            const isActive = r <= hovered.rows && c <= hovered.cols;

            return (
              <div
                key={`${r}-${c}`}
                className={clsx(
                  "w-6 h-6 border rounded-sm transition-colors cursor-pointer",
                  isActive
                    ? "bg-emerald-100 border-emerald-500 dark:bg-emerald-900/50 dark:border-emerald-500"
                    : "bg-white border-neutral-200 dark:bg-neutral-800 dark:border-neutral-700"
                )}
                onMouseEnter={() => setHovered({ rows: r, cols: c })}
                onClick={() => onSelect(r, c)}
              />
            );
          })
        ))}
      </div>
    </div>
  );
}
