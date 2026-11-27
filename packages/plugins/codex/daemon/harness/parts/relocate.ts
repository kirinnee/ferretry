import { CodexRelocation } from '../../adapters/relocation.ts';
import type { HarnessPart } from './context.ts';

/** Moving a ferret to another machine: its conversation packed here, and unpacked into the new ferret's home there. */
export const relocatePart: HarnessPart<'packConversation' | 'unpackConversation'> = ({
  kernel,
  rollouts,
  ensureHome,
  homeOf,
  poolHistory,
}) => {
  const relocation = new CodexRelocation({ kernel, rollouts, ensureHome, homeOf, poolHistory });
  return { packConversation: relocation.pack, unpackConversation: relocation.unpack };
};
