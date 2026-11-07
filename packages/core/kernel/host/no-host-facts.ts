import type { HostFactsPort } from '../contract/ports.ts';
import { undeclaredHostFacts } from './adapters/host-facts.ts';

/** A host with no facts adapter (a suite): nothing to read, every read refuses. */
export const NO_HOST_FACTS: HostFactsPort = undeclaredHostFacts('this host', {
  platform: process.platform,
  cpus: 1,
  totalMemoryBytes: 0,
} as HostFactsPort);
