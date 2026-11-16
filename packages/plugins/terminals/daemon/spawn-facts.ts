import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { SessionSpawnFacts, SessionSpawnFactsPort } from './lib/cgroups/index.ts';

/**
 * A ferret's spawn facts for the cgroup exemption, from the registry: its LABEL (the exemption trims it to the Warden's
 * label) and its parent. The callsign is never the label: a ferret merely named `fleet-warden` is not the Warden.
 */
export function spawnFactsOf(ferrets: Pick<FerretsApi, 'get'>): SessionSpawnFactsPort {
  return {
    facts: async id => {
      const ferret = await ferrets.get(id as FerretId);
      if (ferret === undefined) return undefined;
      const facts: SessionSpawnFacts = {
        ...(ferret.label === undefined ? {} : { label: ferret.label }),
        ...(ferret.parent === undefined ? {} : { parent: ferret.parent }),
      };
      return facts;
    },
  };
}
