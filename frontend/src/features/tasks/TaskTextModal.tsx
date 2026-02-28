import { useTranslation } from 'react-i18next';
import Modal from '../../components/ui/Modal';

interface TaskTextModalProps {
  text: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function TaskTextModal({ text, isOpen, onClose }: TaskTextModalProps) {
  const { t } = useTranslation();

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t('tasks.textModal.title')} size="md">
      <p className="whitespace-pre-wrap break-words text-sm text-neutral-900 dark:text-neutral-100">
        {text}
      </p>
    </Modal>
  );
}
