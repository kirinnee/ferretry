/** What the Vault's input card hands Accounts' panels, with fake data only: no real account, seed or code. */

import { type InputSaved, InputSavedSchema } from '@ferretry/core-vault/contract';

export const REQUEST_ID = 'a'.repeat(32);
const FERRET = 'fy_ferret_pip';

/** A code card for github.com: two accounts sign in there, and the daemon chose none (no primary). */
export const savedTwo = (over: Partial<Record<keyof InputSaved, unknown>> = {}): InputSaved =>
  InputSavedSchema.parse({
    match: 'github.com',
    offers: [
      { id: 'GITHUB_WORK', label: 'GitHub (work)', fills: 'totp', matched: true, signIn: 'si_0000000000000002' },
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'kirinnee',
        fills: 'totp',
        matched: true,
        signIn: 'si_0000000000000001',
      },
    ],
    ...over,
  });

/** The same card with the daemon's one-tap choice made. */
export const savedPrimary = (id: 'GITHUB' | 'GITHUB_WORK' = 'GITHUB'): InputSaved =>
  savedTwo({
    offers: [
      {
        id: 'GITHUB_WORK',
        label: 'GitHub (work)',
        fills: 'totp',
        matched: true,
        signIn: 'si_0000000000000002',
        ...(id === 'GITHUB_WORK' ? { primary: true, why: 'site' } : {}),
      },
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'kirinnee',
        fills: 'totp',
        matched: true,
        signIn: 'si_0000000000000001',
        ...(id === 'GITHUB' ? { primary: true, why: 'site' } : {}),
      },
    ],
  });

/** The props of the codes slot, as the card builds them (plus the shell's `subject`). */
export const codesSlot = (
  over: Record<string, unknown> = {},
): Record<string, unknown> & { readonly refresh: () => void } => {
  const refresh = (): void => undefined;
  return { requestId: REQUEST_ID, ferretId: FERRET, saved: savedPrimary(), refresh, subject: FERRET, ...over } as never;
};

/** The props of the settled slot after a tap on GitHub, with a resolved project. */
export const settledSlot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ferret: FERRET,
  request: 'ir_0123456789abcdef',
  entry: 'GITHUB',
  signIn: 'si_0000000000000001',
  place: 'github.com',
  project: { id: '0b6f3c1e-2d4a-4c8b-9e1f-7a5d3c2b1a09', name: 'demo-project' },
  subject: FERRET,
  ...over,
});
