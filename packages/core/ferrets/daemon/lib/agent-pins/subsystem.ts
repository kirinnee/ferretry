import type { SessionView } from '@ferretry/protocol';
import type { SessionDirectorySubsystem } from '../runtime/mounts/sessions.ts';
import type { AgentPinService } from './service.ts';
import { AgentPinError } from './types.ts';

/**
 * Pinning and unpinning one ferret, from the reference a caller typed to the view it will see.
 *
 * `reader` is the session reader WITH the pin mark on it, so the answer carries `pinnedAt` (or does not)
 * exactly as the next list will.
 */
export class AgentPinSubsystem {
  constructor(
    private readonly reader: Pick<SessionDirectorySubsystem, 'get'>,
    private readonly pins: AgentPinService,
  ) {}

  async pin(reference: string): Promise<SessionView> {
    const id = await this.resolve(reference);
    await this.pins.pin(id);
    return await this.view(id);
  }

  async unpin(reference: string): Promise<SessionView> {
    const id = await this.resolve(reference);
    await this.pins.unpin(id);
    return await this.view(id);
  }

  private async resolve(reference: string): Promise<string> {
    const view = await this.reader.get(reference);
    if (view === undefined) throw new AgentPinError('not-found', `no session ${reference}`);
    return view.config.id;
  }

  private async view(id: string): Promise<SessionView> {
    const view = await this.reader.get(id);
    if (view === undefined) throw new AgentPinError('not-found', `no session ${id}`);
    return view;
  }
}
