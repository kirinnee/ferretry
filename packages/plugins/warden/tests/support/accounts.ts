import type { CoreAccount } from '../../daemon/lib/foreign.ts';

/** A login as the inventory lists it: unattended and available unless told otherwise. */
export const account = (overrides: Partial<CoreAccount> & Pick<CoreAccount, 'id'>): CoreAccount => ({
  agent: overrides.agent ?? overrides.id,
  kind: 'claude',
  mode: 'auto',
  available: true,
  ...overrides,
});
