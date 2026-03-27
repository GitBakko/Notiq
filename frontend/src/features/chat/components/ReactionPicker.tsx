import { useEffect, useRef } from 'react';
import { Plus } from 'lucide-react';

const QUICK_REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'];

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onOpenFull: () => void;
  onClose: () => void;
  position: { x: number; y: number };
}

export default function ReactionPicker({ onSelect, onOpenFull, onClose, position }: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [onClose]);

  // Clamp position to stay within viewport
  const left = Math.min(position.x, window.innerWidth - 320);
  const top = Math.max(8, position.y - 56);

  return (
    <div
      ref={ref}
      className="fixed z-50 flex items-center gap-0.5 px-2 py-1.5 rounded-full bg-white dark:bg-neutral-800 shadow-lg border border-neutral-200/60 dark:border-neutral-700/40 animate-in zoom-in-95 duration-150"
      style={{ left, top }}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => { onSelect(emoji); onClose(); }}
          className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full text-xl hover:bg-neutral-100 dark:hover:bg-neutral-700 active:bg-neutral-200 dark:active:bg-neutral-600 transition-colors"
        >
          {emoji}
        </button>
      ))}
      <button
        onClick={() => { onOpenFull(); onClose(); }}
        className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-full text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 active:bg-neutral-200 dark:active:bg-neutral-600 transition-colors"
        aria-label="More reactions"
      >
        <Plus size={18} />
      </button>
    </div>
  );
}
