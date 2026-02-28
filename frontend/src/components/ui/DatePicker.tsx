import { format } from 'date-fns';
import { it, enUS } from 'date-fns/locale';
import { useTranslation } from 'react-i18next';
import { Calendar as CalendarIcon } from 'lucide-react';
import { DayPicker } from 'react-day-picker';
import * as Popover from '@radix-ui/react-popover';
import { clsx } from 'clsx';
import 'react-day-picker/style.css';

interface DatePickerProps {
  date?: Date;
  onSelect: (date?: Date) => void;
  placeholder?: string;
  className?: string;
  disabled?: { before: Date };
}

export default function DatePicker({ date, onSelect, placeholder = "Pick a date", className, disabled }: DatePickerProps) {
  const { i18n } = useTranslation();
  const currentLocale = i18n.language.startsWith('it') ? it : enUS;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          className={clsx(
            "flex w-full items-center justify-start gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm ring-offset-white placeholder:text-neutral-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/40 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:bg-neutral-800 dark:text-white dark:ring-offset-neutral-900 dark:focus:ring-emerald-500/40 transition-all duration-200",
            !date && "text-neutral-500 dark:text-neutral-400",
            className
          )}
        >
          <CalendarIcon size={16} className="text-neutral-500 dark:text-neutral-400" />
          <span>{date ? format(date, 'PPP', { locale: currentLocale }) : placeholder}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="z-50 bg-white dark:bg-neutral-800 rounded-lg shadow-xl border border-neutral-200/60 dark:border-neutral-700/40 p-2" align="start">
          <DayPicker
            mode="single"
            selected={date}
            onSelect={onSelect}
            disabled={disabled}
            locale={currentLocale}
            captionLayout="dropdown"
            fromYear={1900}
            toYear={new Date().getFullYear()}
            style={{
              '--rdp-accent-color': '#059669', // emerald-600
              '--rdp-background-color': '#ecfdf5', // emerald-50
            } as React.CSSProperties}
            modifiersClassNames={{
              selected: 'bg-emerald-600 text-white hover:bg-emerald-700',
              today: 'text-emerald-600 font-bold',
            }}
            classNames={{
              nav_button: '!text-neutral-600 dark:!text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-700 rounded p-1',
              nav_button_previous: 'absolute left-1',
              nav_button_next: 'absolute right-1',
              caption: 'relative flex justify-center items-center pt-1 pb-3',
              caption_label: 'hidden',
              table: 'w-full border-collapse space-y-1',
              head_row: 'flex',
              head_cell: 'text-neutral-500 rounded-md w-9 font-normal text-[0.8rem] dark:text-neutral-400',
              row: 'flex w-full mt-2',
              cell: 'text-center text-sm p-0 relative [&:has([aria-selected])]:bg-emerald-50 first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20 dark:[&:has([aria-selected])]:bg-emerald-900/30',
              day: 'h-9 w-9 p-0 font-normal aria-selected:opacity-100 hover:bg-neutral-100 rounded-md dark:hover:bg-neutral-700 dark:text-neutral-100',
              day_selected: 'bg-emerald-600 text-white hover:bg-emerald-600 hover:text-white focus:bg-emerald-600 focus:text-white',
              day_today: 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100',
              day_outside: 'text-neutral-500 opacity-50 dark:text-neutral-500',
              day_disabled: 'text-neutral-500 opacity-50 dark:text-neutral-500',
              day_range_middle: 'aria-selected:bg-emerald-50 aria-selected:text-emerald-900 dark:aria-selected:bg-emerald-900/30 dark:aria-selected:text-emerald-100',
              day_hidden: 'invisible',
              dropdown_month: 'flex items-center justify-between mr-2',
              dropdown_year: 'flex items-center justify-between ml-2',
              dropdown: 'p-2 bg-white dark:bg-neutral-800 border border-neutral-200/60 dark:border-neutral-700/40 rounded-md shadow-sm text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 dark:text-white',
            }}
            className="dark:text-white"
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
