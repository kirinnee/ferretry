import type { RuntimesApi } from '@ferretry/plugin-runtimes/contract';
import { type CoreAccount } from '../lib/foreign.ts';
import { FleetWardenAgents } from '../lib/index.ts';
import type { WardenAgentInventory } from '../lib/sweep.ts';

/**
 * The logins the Warden may investigate on, read from Runtimes: the agent runtimes of this machine by NAME (the spelling
 * `warden.yaml` stores and a start resolves), and the machine's default runtime for an owner who never chose one.
 *
 * Both are read each time, never kept: a runtime added, switched off or made the default is the next read's answer.
 * Runtimes not answering is "unreadable" — no names and no default — which condemns no account (`WardenAgentInventory`)
 * and leaves the login `not_set`, so the Warden says so rather than inventing one.
 *
 * A runtime that is signed out is still listed: Ferrets resolves the runtime at the start and refuses a signed-out one,
 * and the sweep then strikes that account and tries the next. Only a runtime switched off is not offered.
 */
export function runtimesWardenAgents(
  runtimes: () => Pick<RuntimesApi, 'catalog' | 'default'> | undefined,
): WardenAgentInventory {
  const inventory = {
    accounts: async (): Promise<readonly CoreAccount[]> => {
      const api = runtimes();
      if (api === undefined) return [];
      return (await api.catalog())
        .filter(runtime => runtime.agent)
        .map(runtime => ({
          id: runtime.id,
          agent: runtime.name,
          mode: 'auto' as const,
          available: runtime.disabled === undefined,
        }));
    },
  };
  return new FleetWardenAgents(inventory, async () => await runtimes()?.default());
}
