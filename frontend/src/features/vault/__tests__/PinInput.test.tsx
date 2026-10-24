import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import PinInput from '../PinInput';

function Harness({ initial = '' }: { initial?: string }) {
  const [v, setV] = useState(initial);
  return <PinInput value={v} onChange={setV} label="pin" autoComplete="off" className="" />;
}
const input = () => screen.getByLabelText('pin') as HTMLInputElement;

afterEach(cleanup);

describe('PinInput', () => {
  it('un carattere digitato a meta di un PIN gia lungo 6 non cambia il valore (niente scarto dell ultimo)', () => {
    render(<Harness initial="abcdef" />);
    fireEvent.change(input(), { target: { value: 'abcXdef' } });
    expect(input().value).toBe('abcdef');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('paste o autofill piu lungo tronca a 6 con avviso', () => {
    render(<Harness initial="abc" />);
    fireEvent.change(input(), { target: { value: 'abcdefghij' } });
    expect(input().value).toBe('abcdef');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('paste su un PIN gia lungo 6 (nuovo valore > attuale + 1) tronca con avviso', () => {
    render(<Harness initial="abcdef" />);
    fireEvent.change(input(), { target: { value: 'abcdefghi' } });
    expect(input().value).toBe('abcdef');
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('digitare sotto i 6 caratteri funziona', () => {
    render(<Harness initial="abc" />);
    fireEvent.change(input(), { target: { value: 'abcd' } });
    expect(input().value).toBe('abcd');
  });
});
