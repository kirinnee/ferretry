import type { StatePort } from '@ferretry/kernel/contract';
import { HYPERMEDIA_STATE } from '../../../contract/index.ts';

/**
 * The hypermedia switch a ferret's owner set, one small document per ferret (`<ferret>/hypermedia.json`). A ferret
 * with none follows its mode's default; the launch reads this to decide `FY_HYPERMEDIA`.
 */
export class StateHypermediaSwitch {
  constructor(private readonly state: StatePort) {}

  /** The value the owner set, or `undefined` when none was (an unreadable file is none). */
  async recorded(ferret: string): Promise<boolean | undefined> {
    const read = await this.state.read(HYPERMEDIA_STATE, ferret);
    return read.ok ? read.value?.enabled : undefined;
  }

  async write(ferret: string, enabled: boolean, at: string): Promise<void> {
    await this.state.write(HYPERMEDIA_STATE, { format: 1, enabled, updatedAt: at }, ferret);
  }

  /** The ferret is gone: its switch goes with it. */
  async forget(ferret: string): Promise<void> {
    await this.state.remove(HYPERMEDIA_STATE, ferret);
  }
}
