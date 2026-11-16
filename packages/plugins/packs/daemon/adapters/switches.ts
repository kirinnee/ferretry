import type { StatePort } from '@ferretry/kernel/contract';
import { PACK_SWITCHES } from '../../contract/index.ts';

/**
 * Each ferret's own Pack switch (`PATCH /v1/ferrets/:ferretId/pack`), in `state/packs/switches.json`. Absent means ON.
 * A damaged document reads as on for every ferret: the switch only ever turns Pack mode OFF for one ferret, so reading
 * it as on can tell a ferret about a door the owner closed, but never opens a limit (the limits hold either way).
 */
export class StatePackSwitches {
  constructor(private readonly state: Pick<StatePort, 'read' | 'update'>) {}

  /** The recorded switch; `undefined` when nothing was recorded (on). */
  async get(ferret: string): Promise<boolean | undefined> {
    const read = await this.state.read(PACK_SWITCHES);
    return read.ok ? read.value?.ferrets[ferret]?.enabled : undefined;
  }

  async set(ferret: string, enabled: boolean, at: string): Promise<void> {
    await this.state.update(PACK_SWITCHES, current => ({
      format: 1 as const,
      ferrets: { ...current?.ferrets, [ferret]: { enabled, at } },
    }));
  }
}
