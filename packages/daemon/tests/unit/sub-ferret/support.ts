import type { SubFerretDirectory } from '../../../src/lib/sub-ferret/index.ts';

/** `child` and `grandchild` are sub-ferrets; `lead` (callsign `lizzette`) and `stranger` are leads. */
export const DIRECTORY: SubFerretDirectory = {
  leadOf: async sessionId => ({ child: 'lead', grandchild: 'child' })[sessionId],
  addressOf: async sessionId => (sessionId === 'lead' ? 'lizzette' : sessionId),
};

export const REFUSED = /^Sub-ferrets don't .+; tell your lead: fy send lizzette "…"$/;
