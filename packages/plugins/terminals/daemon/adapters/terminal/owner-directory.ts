import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import type { TerminalOwnerDirectory, TerminalOwnerStanding } from '../../lib/terminal/contracts.ts';
import { standingOfSessionStatus } from '../../lib/terminal/holders.ts';

/**
 * Who holds terminals, read from the Ferrets port (today's `StorageTerminalOwnerDirectory`, which read the session's
 * own documents): a ferret Ferrets does not hold is gone; otherwise its state word decides, and its name labels it.
 */
export class FerretTerminalOwnerDirectory implements TerminalOwnerDirectory {
  constructor(private readonly ferrets: Pick<FerretsApi, 'get'>) {}

  async standing(ownerId: string): Promise<TerminalOwnerStanding> {
    const ferret = await this.ferrets.get(ownerId as FerretId).catch(() => undefined);
    if (ferret === undefined) return { ...standingOfSessionStatus(undefined), label: ownerId };
    return { ...standingOfSessionStatus(ferret.state), label: ferret.name };
  }
}
