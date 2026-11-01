import { realpath } from 'node:fs/promises';
import { resolveStateHomes, type StateHomes } from '@ferretry/fleet';
import { NodeGuardDisk } from '@ferretry/fleet/adapters';
import type { StateHomeReach } from '../../lib/api/state-homes.ts';

/** The daemon's own directories over Node: resolved per call, so a moved or relinked home is seen at once. */
export class NodeStateHomes implements StateHomeReach {
  private readonly disk = new NodeGuardDisk();

  constructor(private readonly configured: readonly string[]) {}

  async resolve(): Promise<StateHomes> {
    return await resolveStateHomes({ homes: this.configured }, this.disk);
  }

  async realpath(path: string): Promise<string | undefined> {
    return await realpath(path).catch(() => undefined);
  }
}
