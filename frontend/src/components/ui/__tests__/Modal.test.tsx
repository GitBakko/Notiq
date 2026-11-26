import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import Modal from '../Modal';

describe('Modal', () => {
  it('il dialog ha un nome accessibile: aria-labelledby punta al titolo (id da useId)', () => {
    render(<Modal isOpen onClose={() => {}} title="Reset the vault"><p>x</p></Modal>);
    const dlg = screen.getByRole('dialog');
    const id = dlg.getAttribute('aria-labelledby');
    expect(id).toBeTruthy();
    expect(document.getElementById(id!)?.textContent).toBe('Reset the vault');
    expect(screen.getByRole('dialog', { name: 'Reset the vault' })).toBe(dlg);
    expect(dlg.getAttribute('aria-modal')).toBe('true');
  });

  it('due modal aperti insieme hanno id diversi', () => {
    render(<><Modal isOpen onClose={() => {}} title="A"><p>a</p></Modal><Modal isOpen onClose={() => {}} title="B"><p>b</p></Modal></>);
    const [a, b] = screen.getAllByRole('dialog');
    expect(a.getAttribute('aria-labelledby')).not.toBe(b.getAttribute('aria-labelledby'));
  });

  it('chiuso: niente', () => {
    const { container } = render(<Modal isOpen={false} onClose={() => {}} title="A"><p>a</p></Modal>);
    expect(container.innerHTML).toBe('');
  });

  it('sheet: bottom sheet su mobile (rounded-t-2xl, maniglia), centrato da sm in su', () => {
    render(<Modal isOpen sheet onClose={() => {}} title="A"><p>a</p></Modal>);
    expect(screen.getByRole('dialog').className).toContain('rounded-t-2xl');
  });
});
