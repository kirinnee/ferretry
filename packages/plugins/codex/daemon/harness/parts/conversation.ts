import type { HarnessPart } from './context.ts';

/** Which conversation a ferret holds: whether one exists, importing one, and the one a launch provably wrote. */
export const conversationPart: HarnessPart<
  'hasConversation' | 'importConversation' | 'provedConversation' | 'conversations'
> = ({ rollouts }) => {
  return {
    // A ferret converted from v4 names a conversation whose rollout was left behind: proved absent, Ferrets starts anew.
    hasConversation: async (spec, harnessConversation) => await rollouts.has(spec.ferret, harnessConversation),
    importConversation: async input => await rollouts.import(input),
    // Codex names its conversation after launch: the one this launch provably wrote, so Ferrets records it for a resume.
    provedConversation: async ferret => await rollouts.provedConversation(ferret),
    conversations: rollouts.conversations,
  };
};
