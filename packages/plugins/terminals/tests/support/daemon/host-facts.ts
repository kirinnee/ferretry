import type { HostFactsPort } from '@ferretry/kernel/contract';

/** A host whose launch guard is off (the owner's own machine): Terminals only asks this one fact of a suite. */
export const unarmedHostFacts = {
  launchGuard: () => ({ active: false }),
} as unknown as HostFactsPort;
