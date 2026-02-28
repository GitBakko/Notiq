import { useState, useEffect } from 'react';
import { Dialog } from './Dialog';
import { Button } from './Button';
import { Input } from './Input';

interface InputDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
}

export function InputDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  defaultValue = '',
  placeholder = '',
  confirmText = 'Confirm',
  cancelText = 'Cancel',
}: InputDialogProps) {
  const [value, setValue] = useState(defaultValue);

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
    }
  }, [isOpen, defaultValue]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onConfirm(value);
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onClose={onClose} title={title}>
      <form onSubmit={handleSubmit}>
        {message && (
          <div className="mt-2 mb-4">
            <p className="text-sm text-neutral-500 dark:text-neutral-400">{message}</p>
          </div>
        )}

        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          autoFocus
          className="w-full"
        />

        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            {cancelText}
          </Button>
          <Button type="submit" variant="primary">
            {confirmText}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
