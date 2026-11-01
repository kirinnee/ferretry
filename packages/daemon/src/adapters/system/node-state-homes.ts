import { judgeOutsideStateHomes, resolveStateHomes, type StateHomes } from '@ferretry/fleet';
import { NodeGuardDisk } from '@ferretry/fleet/adapters';
import type { StateHomeReach } from '../../lib/api/state-homes.ts';

/** The daemon's own directories over Node: resolved per call, so a moved or relinked home is seen at once. */
export class NodeStateHomes implements StateHomeReach {
  private readonly disk = new NodeGuardDisk();

  /** `pinned`: the homes' key files and folders, recognised by identity wherever they are bound. */
  constructor(
    private readonly configured: readonly string[],
    private readonly pinned: readonly string[] = [],
  ) {}

  async resolve(): Promise<StateHomes> {
    return await resolveStateHomes({ homes: this.configured, pinned: this.pinned }, this.disk);
  }

  async holding(path: string): Promise<string | undefined> {
    const homes = await this.resolve();
    const judged = await judgeOutsideStateHomes(path, homes, this.disk, { hops: 'every' });
    if (judged.ok || judged.rule !== 'state-home') return undefined;
    return judged.home ?? homes.homes[0]?.named;
  }
}
