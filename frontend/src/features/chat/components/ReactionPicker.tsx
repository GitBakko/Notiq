import { useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';

const QUICK_REACTIONS = ['\u{1F44D}', '\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F64F}'];

interface ReactionPickerProps {
  onSelect: (emoji: string) => void;
  onOpenFull: () => void;
  onClose: () => void;
  position?: { x: number; y: number };
}

export default function ReactionPicker({ onSelect, onOpenFull, onClose, position }: ReactionPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  // Animate in on mount
  useEffect(() => {
    requestAnimationFrame(() => setVisible(true));
  }, []);

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

  // Position picker ABOVE or BELOW the click point, ensuring the message stays visible
  const pickerWidth = 340;
  const pickerHeight = 52;
  const spaceAbove = position ? position.y - pickerHeight - 16 : 0;
  const showAbove = spaceAbove > 8; // enough room above?
  const positionStyle = position
    ? {
        left: Math.max(8, Math.min(position.x - pickerWidth / 2, window.innerWidth - pickerWidth - 8)),
        top: showAbove
          ? position.y - pickerHeight - 16 // above the click, with 16px gap
          : position.y + 16,               // below the click, with 16px gap
      }
    : {};

  return (
    <div
      ref={ref}
      className="fixed z-50 flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40"
      style={{
        ...positionStyle,
        boxShadow: '0 8px 30px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)',
        transform: visible
          ? 'scale(1) translateY(0)'
          : `scale(0.85) translateY(${showAbove ? '6px' : '-6px'})`,
        opacity: visible ? 1 : 0,
        transition: 'transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 150ms ease-out',
        transformOrigin: showAbove ? 'center bottom' : 'center top',
      }}
    >
      {QUICK_REACTIONS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => { onSelect(emoji); onClose(); }}
          className="w-10 h-10 flex items-center justify-center rounded-full text-xl hover:bg-neutral-100 dark:hover:bg-neutral-700 active:scale-125 transition-all duration-150"
        >
          {emoji}
        </button>
      ))}
      <div className="w-px h-6 bg-neutral-200 dark:bg-neutral-700 mx-0.5" />
      <button
        onClick={() => { onOpenFull(); onClose(); }}
        className="w-10 h-10 flex items-center justify-center rounded-full text-neutral-400 dark:text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 active:scale-110 transition-all duration-150"
        aria-label="More reactions"
      >
        <Plus size={18} />
      </button>
    </div>
  );
}
