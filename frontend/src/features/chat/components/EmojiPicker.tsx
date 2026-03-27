import { useEffect, useRef } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ onSelect, onClose }: EmojiPickerProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Detect dark mode
  const isDark = document.documentElement.classList.contains('dark');

  return (
    <div ref={ref} className="absolute bottom-full mb-2 left-0 z-50">
      <Picker
        data={data}
        onEmojiSelect={(emoji: { native: string }) => onSelect(emoji.native)}
        theme={isDark ? 'dark' : 'light'}
        previewPosition="none"
        skinTonePosition="search"
        maxFrequentRows={2}
        perLine={8}
      />
    </div>
  );
}
