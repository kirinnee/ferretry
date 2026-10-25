import { resolveRuntimeReference } from '@ferretry/fleet';
import { type AccountInventoryPort, selectableAutoAccounts } from '../core/inventory.ts';
import type { RuntimeNamesPort } from '../fleet/start-resolution.ts';
import type { WardenAgentInventory } from './sweep.ts';

/**
 * The Warden's view of the fleet's logins, by NAME.
 *
 * A login is spelled the way an operator types it (`claude-default`): that is what `warden.yaml`
 * stores, what the picker offers, what a usage row is keyed by and what a start resolves. The fleet
 * manifest's opaque id is a different spelling of the same runtime, and offering it here made the
 * Warden's own check call a valid login unknown and its failover call it not installed.
 */
export class FleetWardenAgents implements WardenAgentInventory {
  constructor(
    private readonly inventory: AccountInventoryPort & Partial<RuntimeNamesPort>,
    readonly defaultRuntime: () => Promise<string | undefined>,
  ) {}

  async installed(): Promise<readonly string[]> {
    return selectableAutoAccounts(await this.inventory.accounts()).map(account => account.agent);
  }

  /**
   * The name a stored reference means today: a runtime's own name, else the name it had before, else
   * its id — the order a start resolves in. `undefined` for a reference no runtime answers to, and
   * for an `ids.json` that cannot be read: a reference left alone is never worse than a wrong rewrite.
   */
  async currentName(reference: string): Promise<string | undefined> {
    const published = await this.inventory.accounts();
    const byName = published.find(account => account.agent === reference);
    if (byName !== undefined) return byName.agent;
    const ids = await this.inventory.ids?.().catch(() => undefined);
    const renamed = ids === undefined ? undefined : resolveRuntimeReference(ids, reference);
    if (renamed !== undefined && published.some(account => account.agent === renamed.name)) return renamed.name;
    return published.find(account => account.id === reference)?.agent;
  }
}
