import type { SubFerretDirectory } from '../../../../daemon/lib/sub-ferret/index.ts';

/** `child` and `grandchild` are sub-ferrets; `lead` (callsign `lizzette`) and `stranger` are leads. */
export const DIRECTORY: SubFerretDirectory = {
  leadOf: async sessionId => ({ child: 'lead', grandchild: 'child' })[sessionId],
  addressOf: async sessionId => (sessionId === 'lead' ? 'lizzette' : sessionId),
};
