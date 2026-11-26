import type { KeyringDto } from '../../lib/vaultSession';

/** Perche' il foglio del Kit e' obbligatorio: recupero rilasciato e poi annullato/scaduto, oppure chiave root ritirata (1.15.1). */
export type KitRotationReason = 'recovery' | 'retired';

/**
 * F10: con un rilascio aperto il PUT con l'escrow darebbe 409 recoveryInProgress, il foglio non serve (e non si puo' completare).
 * `rootKeyRetired`: l'escrow e' sigillato con una chiave ritirata, la rigenerazione lo risigilla con quella attiva.
 */
export function rotationOf(kr: Pick<KeyringDto, 'kitRotationRequired' | 'rootKeyRetired' | 'openRecovery'>): KitRotationReason | false {
  if (kr.openRecovery?.status === 'RELEASED') return false;
  return kr.rootKeyRetired === true ? 'retired' : kr.kitRotationRequired === true ? 'recovery' : false;
}
