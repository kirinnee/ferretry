import type { HarnessPart } from './context.ts';

/** Reading a ferret's transcript and what it used, from the rollouts Codex writes. */
export const transcriptPart: HarnessPart<
  'transcript' | 'transcriptStamp' | 'transcriptTail' | 'transcriptBytes' | 'usage'
> = ({ rollouts }) => {
  return {
    transcript: rollouts.transcript,
    transcriptStamp: rollouts.stamp,
    transcriptTail: rollouts.tail,
    transcriptBytes: rollouts.bytes,
    usage: rollouts.usage,
  };
};
