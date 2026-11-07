import type { AgentPinService } from './service.ts';
import { AgentPinError } from './types.ts';
import type { PinnedFerret, PinnedFerretReader } from './view.ts';

/**
 * Pinning and unpinning one ferret, from the reference a caller typed to the ferret it will see.
 *
 * `reader` is the ferret reader WITH the pin mark on it, so the answer carries `pinnedAt` (or does not) exactly as
 * the next list will.
 */
export class AgentPinSubsystem {
  constructor(
    private readonly reader: Pick<PinnedFerretReader, 'get'>,
    private readonly pins: AgentPinService,
  ) {}

  async pin(reference: string): Promise<PinnedFerret> {
    const id = await this.resolve(reference);
    await this.pins.pin(id);
    return await this.view(id);
  }

  async unpin(reference: string): Promise<PinnedFerret> {
    const id = await this.resolve(reference);
    await this.pins.unpin(id);
    return await this.view(id);
  }

  private async resolve(reference: string): Promise<string> {
    const ferret = await this.reader.get(reference);
    if (ferret === undefined) throw new AgentPinError('not-found', `no ferret ${reference}`);
    return ferret.id;
  }

  private async view(id: string): Promise<PinnedFerret> {
    const ferret = await this.reader.get(id);
    if (ferret === undefined) throw new AgentPinError('not-found', `no ferret ${id}`);
    return ferret;
  }
}
