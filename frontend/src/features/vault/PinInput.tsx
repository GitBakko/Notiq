import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Lunghezza del PIN (vedi PinPolicy). Oltre, il valore viene troncato: l'utente deve saperlo (C.3/C.4). */
const PIN_LENGTH = 6;

interface Props {
  value: string;
  onChange: (v: string) => void;
  label: string;
  autoComplete: string;
  className: string;
  id?: string;
  autoFocus?: boolean;
}

/**
 * Campo PIN: tiene i primi 6 caratteri e, se ne arrivano di piu' (tipicamente una password suggerita dal gestore),
 * avvisa che e' stata troncata. Niente `maxLength`: il browser taglierebbe in silenzio.
 */
export default function PinInput({ value, onChange, label, autoComplete, className, id, autoFocus }: Props) {
  const { t } = useTranslation();
  const [cut, setCut] = useState(0); // lunghezza originale dell'ultimo inserimento troncato; 0 = nessun troncamento

  return (
    <>
      <input
        id={id}
        type="password"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          // un solo carattere digitato su un PIN gia' pieno: si ignora (come maxLength), senza scartare l'ultimo
          if (value.length >= PIN_LENGTH && v.length === value.length + 1) return;
          setCut(v.length > PIN_LENGTH ? v.length : 0);
          onChange(v.slice(0, PIN_LENGTH));
        }}
        placeholder={label}
        aria-label={label}
        autoComplete={autoComplete}
        autoCapitalize="off"
        spellCheck={false}
        className={className}
        autoFocus={autoFocus}
      />
      {cut > 0 && value !== '' && (
        <p role="status" className="text-left text-xs text-amber-700 dark:text-amber-400">
          {t('vault.pinTruncated', { max: PIN_LENGTH, n: cut })}
        </p>
      )}
    </>
  );
}
