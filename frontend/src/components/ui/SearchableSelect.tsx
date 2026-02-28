import { useState } from 'react';
import { Command } from 'cmdk';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronsUpDown } from 'lucide-react';
import { clsx } from 'clsx';

export interface Option {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

interface SearchableSelectProps {
  options: Option[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  disabled?: boolean;
}

export default function SearchableSelect({
  options,
  value,
  onChange,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found.",
  className,
  disabled
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedOption = options.find(o => o.value === value);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={clsx(
            "flex w-full items-center justify-between rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm ring-offset-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-white dark:ring-offset-neutral-900 dark:focus:ring-emerald-500/40 transition-all duration-200",
            className
          )}
        >
          <span className="truncate flex items-center">
            {selectedOption?.icon && <span className="mr-2 flex items-center">{selectedOption.icon}</span>}
            {selectedOption ? selectedOption.label : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="z-50 w-[200px] p-0 bg-white dark:bg-neutral-800 rounded-lg shadow-xl border border-neutral-200/60 dark:border-neutral-700/40 overflow-hidden" align="start" style={{ width: 'var(--radix-popover-trigger-width)' }}>
          <Command className="w-full">
            <div className="flex items-center border-b border-neutral-100 dark:border-neutral-700 px-3" cmdk-input-wrapper="">
              <Command.Input
                placeholder={searchPlaceholder}
                className="flex h-10 w-full rounded-lg bg-transparent py-3 text-sm outline-none placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:opacity-50 dark:text-white"
              />
            </div>
            <Command.List className="max-h-[300px] overflow-y-auto overflow-x-hidden p-1">
              <Command.Empty className="py-6 text-center text-sm text-neutral-500 dark:text-neutral-400">
                {emptyMessage}
              </Command.Empty>
              <Command.Group>
                {options.map((option) => (
                  <Command.Item
                    key={option.value}
                    value={option.label}
                    onSelect={() => {
                      onChange(option.value);
                      setOpen(false);
                    }}
                    className={clsx(
                      "relative flex cursor-pointer select-none items-center rounded-md px-2 py-1.5 text-sm outline-none aria-selected:bg-emerald-50 aria-selected:text-emerald-900 dark:aria-selected:bg-emerald-900/30 dark:aria-selected:text-emerald-100 dark:text-neutral-200",
                      value === option.value && "bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100"
                    )}
                  >
                    <Check
                      className={clsx(
                        "mr-2 h-4 w-4",
                        value === option.value ? "opacity-100" : "opacity-0"
                      )}
                    />
                    {option.icon && <span className="mr-2 flex items-center">{option.icon}</span>}
                    {option.label}
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
