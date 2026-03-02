import { useState, useRef, useEffect } from 'react';
import { Type, ChevronDown } from 'lucide-react';
import clsx from 'clsx';

export interface DropdownOption {
  label: string;
  value: string;
}

interface ToolbarDropdownProps {
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  title: string;
  icon?: React.ReactNode;
}

export default function ToolbarDropdown({ options, value, onChange, placeholder, title, icon }: ToolbarDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const selectedLabel = options.find(o => o.value === value)?.label || placeholder;

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        title={title}
        className="flex items-center gap-1 px-2 py-1.5 rounded text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800 transition-colors min-w-[80px]"
      >
        {icon || <Type size={14} />}
        <span className="truncate">{selectedLabel}</span>
        <ChevronDown size={12} className={clsx("transition-transform", isOpen && "rotate-180")} />
      </button>
      {isOpen && (
        <div className="absolute top-full left-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200/60 dark:border-neutral-700/40 rounded-lg shadow-lg z-50 min-w-[140px]">
          {options.map((option) => (
            <button
              key={option.value}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
              }}
              className={clsx(
                "w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 first:rounded-t-lg last:rounded-b-lg transition-colors",
                option.value === value
                  ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/20 dark:text-emerald-400"
                  : "text-neutral-700 dark:text-neutral-300"
              )}
              style={option.value ? { fontFamily: option.value } : undefined}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
