/** Codice del reset in forma canonica: senza trattini e spazi, maiuscolo, con gli alias Crockford (O->0, I e L->1). Il server ha la stessa tolleranza. */
export const normalizeResetCode = (s: string) => s.replace(/[\s-]/g, '').toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1');
