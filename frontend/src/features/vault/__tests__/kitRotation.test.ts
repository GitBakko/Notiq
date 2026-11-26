import { describe, it, expect } from 'vitest';
import { rotationOf } from '../kitRotation';

describe('rotationOf', () => {
  it('nessun flag: nessuna rotazione', () => {
    expect(rotationOf({})).toBe(false);
  });
  it('kitRotationRequired: motivo recovery; con RELEASED aperta no (F10)', () => {
    expect(rotationOf({ kitRotationRequired: true })).toBe('recovery');
    expect(rotationOf({ kitRotationRequired: true, openRecovery: { status: 'WAITING' } as never })).toBe('recovery');
    expect(rotationOf({ kitRotationRequired: true, openRecovery: { status: 'RELEASED' } as never })).toBe(false);
  });
  it('rootKeyRetired: motivo retired, anche senza kitRotationRequired; con RELEASED aperta no', () => {
    expect(rotationOf({ rootKeyRetired: true })).toBe('retired');
    expect(rotationOf({ rootKeyRetired: true, kitRotationRequired: true })).toBe('retired');
    expect(rotationOf({ rootKeyRetired: false })).toBe(false);
    expect(rotationOf({ rootKeyRetired: true, openRecovery: { status: 'RELEASED' } as never })).toBe(false);
  });
});
