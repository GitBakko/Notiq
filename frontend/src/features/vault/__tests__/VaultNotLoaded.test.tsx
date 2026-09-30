import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import VaultNotLoaded from '../VaultNotLoaded';

describe('VaultNotLoaded', () => {
  it('unavailable: connect-and-retry copy with a Retry button', () => {
    render(<VaultNotLoaded onRetry={() => {}} onBack={() => {}} />);
    expect(screen.getByText('vault.notLoaded')).toBeTruthy();
    expect(screen.getByText('vault.notLoadedRetry')).toBeTruthy();
  });

  it('emptyOnServer: distinct copy, no Retry, Back available', () => {
    render(<VaultNotLoaded emptyOnServer onRetry={() => {}} onBack={() => {}} />);
    expect(screen.getByText('vault.itemEmptyOnServer')).toBeTruthy();
    expect(screen.queryByText('vault.notLoaded')).toBeNull();
    expect(screen.queryByText('vault.notLoadedRetry')).toBeNull();
    expect(screen.getByText('common.back')).toBeTruthy();
  });

  it('gone: "no longer exists" copy, Back only (no Retry)', () => {
    render(<VaultNotLoaded gone onRetry={() => {}} onBack={() => {}} />);
    expect(screen.getByText('vault.itemNotFound')).toBeTruthy();
    expect(screen.queryByText('vault.notLoaded')).toBeNull();
    expect(screen.queryByText('vault.notLoadedRetry')).toBeNull();
    expect(screen.getByText('common.back')).toBeTruthy();
  });
});
