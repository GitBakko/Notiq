// Dialog delle note illeggibili dopo una rotazione (Fase 5): gruppi D/K entro e oltre il limite, un solo proprietario dello stato nella pagina.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, o?: { count?: number }) => (typeof o?.count === 'number' ? `${k}:${o.count}` : k) }) }));

import StaleNotesDialog, { type StaleItem } from '../StaleNotesDialog';

const it_ = (id: string, reason: StaleItem['reason'], tooLarge = false): StaleItem => ({ id, noteType: 'NOTE', size: 10, reason, tooLarge });
const mount = (items: StaleItem[], o: Partial<React.ComponentProps<typeof StaleNotesDialog>> = {}) => {
  const fns = { onConfirm: vi.fn(), onDeleteDamaged: vi.fn(), onCancel: vi.fn() };
  render(<StaleNotesDialog items={items} busy={false} {...fns} {...o} />);
  return fns;
};
afterEach(cleanup);

describe('StaleNotesDialog', () => {
  it('(a) una sola K oltre il limite: avviso "amministratore", nessun pulsante di eliminazione ne\' di conferma', () => {
    mount([it_('k1', 'keyMissing', true)]);
    expect(screen.getByText('vault.rotation.keyMissingTooLarge:1')).toBeTruthy();
    expect(screen.queryByText(/vault\.rotation\.deleteTooLarge/)).toBeNull();
    expect(screen.queryByText('vault.rotation.confirmRewrap')).toBeNull();
    expect(screen.getByText('common.close')).toBeTruthy();
  });

  it('(b) D oltre il limite: Elimina, ConfirmDialog, poi onDeleteDamaged una volta sola', () => {
    const f = mount([it_('d1', 'damaged', true), it_('d2', 'damaged', true)]);
    expect(screen.getByText('vault.rotation.tooLarge:2')).toBeTruthy();
    expect(screen.queryByText('vault.rotation.confirmRewrap')).toBeNull();
    fireEvent.click(screen.getByText('vault.rotation.deleteTooLarge:2'));
    expect(screen.getByText('vault.rotation.deleteTooLargeConfirm:2')).toBeTruthy();
    expect(f.onDeleteDamaged).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('common.deleteForever'));
    expect(f.onDeleteDamaged).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('dialog')).toHaveLength(1); // un solo overlay alla volta
  });

  it('(c) misto: il conteggio K comprende solo le K entro il limite; il conteggio D solo le D entro il limite', () => {
    const f = mount([
      it_('d1', 'damaged'), it_('d2', 'damaged', true),
      it_('k1', 'keyMissing'), it_('k2', 'keyMissing'), it_('k3', 'keyMissing', true),
    ]);
    expect(screen.getByText('vault.rotation.damaged:1')).toBeTruthy();
    expect(screen.getByText('vault.rotation.keyMissingWarning:2')).toBeTruthy();
    expect(screen.getByText('vault.rotation.tooLarge:1')).toBeTruthy();
    expect(screen.getByText('vault.rotation.keyMissingTooLarge:1')).toBeTruthy();
    expect(screen.getByText('vault.rotation.deleteTooLarge:1')).toBeTruthy();
    fireEvent.click(screen.getByText('vault.rotation.confirmRewrap'));
    expect(f.onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('common.cancel'));
    expect(f.onCancel).toHaveBeenCalledTimes(1);
  });

  it('(d) busy: tutti i pulsanti disabilitati', () => {
    mount([it_('d1', 'damaged'), it_('d2', 'damaged', true)], { busy: true });
    const dlg = screen.getByRole('dialog');
    const buttons = within(dlg).getAllByRole('button').filter((b) => b.textContent !== ''); // esclude la X di chiusura senza testo
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('esito di un giro precedente: riga role=status con residuo e note re-incapsulate', () => {
    mount([it_('d1', 'damaged')], { last: { rewrapped: 3 } });
    const status = screen.getByRole('status');
    expect(within(status).getByText('vault.rotation.residue')).toBeTruthy();
    expect(within(status).getByText('vault.rotation.rewrapDone:3')).toBeTruthy();
  });

  it('D18: U (unverifiable) entro il limite: avviso proprio + rewrap dopo conferma; il conteggio D non la comprende', () => {
    const f = mount([it_('d1', 'damaged'), it_('u1', 'unverifiable'), it_('u2', 'unverifiable')]);
    expect(screen.getByText('vault.rotation.damaged:1')).toBeTruthy();
    expect(screen.getByText('vault.rotation.unverifiableWarning:2')).toBeTruthy();
    expect(screen.queryByText(/keyMissingWarning/)).toBeNull();
    fireEvent.click(screen.getByText('vault.rotation.confirmRewrap'));
    expect(f.onConfirm).toHaveBeenCalledTimes(1);
  });

  it('D18: U oltre il limite: solo avviso "amministratore", nessun pulsante di eliminazione ne di conferma', () => {
    mount([it_('u1', 'unverifiable', true)]);
    expect(screen.getByText('vault.rotation.unverifiableTooLarge:1')).toBeTruthy();
    expect(screen.queryByText(/vault\.rotation\.deleteTooLarge/)).toBeNull();
    expect(screen.queryByText('vault.rotation.confirmRewrap')).toBeNull();
    expect(screen.getByText('common.close')).toBeTruthy();
  });

  it('(e) varianti dark: nei sorgenti del dialog', () => {
    const src = readFileSync(resolve(__dirname, '../StaleNotesDialog.tsx'), 'utf8');
    const colorClasses = src.match(/\b(?:bg|text|border)-(?:amber|red|neutral)-\d+/g) ?? [];
    expect(colorClasses.length).toBeGreaterThan(0);
    for (const c of new Set(colorClasses)) expect(src).toContain(`dark:${c.replace(/-\d+$/, '')}`);
    expect(src).toContain('min-h-[44px]');
  });
});
