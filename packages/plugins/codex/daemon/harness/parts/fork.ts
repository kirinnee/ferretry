import type { HarnessPart } from './context.ts';

/** Forking a ferret's conversation: the rollout cut at a turn into a new one, which a new ferret resumes. */
export const forkPart: HarnessPart<'fork'> = ({ rollouts }) => ({ fork: rollouts.fork });
