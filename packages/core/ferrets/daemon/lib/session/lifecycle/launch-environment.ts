import type { SessionId } from '../../session-id.ts';
import type { SessionEnvironmentStore } from './types.ts';

/** The per-ferret switches a session's record implies, for a launch whose environment never stored them. */
export type LaunchSwitchDefaults = (id: SessionId) => Promise<Readonly<Record<string, string>>>;

/**
 * What a pane is LAUNCHED with: the stored environment over the per-ferret switches its record implies.
 *
 * A stored switch always wins — it is the owner's own, or the start's decision — and only a switch the
 * store never recorded is derived: Pack mode's `FY_PACK` for a ferret started before Pack mode existed,
 * or whose start could not write it. Without this a restart, migration or revive told such a ferret
 * nothing while its record said it was on. Every launch path reads through one of these, so the first
 * launch and the revive cannot disagree. Defaults that cannot be resolved derive nothing, because a
 * launch must never fail on a switch it was not given.
 *
 * Writes go straight through: what is stored is only ever what somebody decided.
 */
export class LaunchEnvironmentStore implements SessionEnvironmentStore {
  constructor(
    private readonly stored: SessionEnvironmentStore,
    private readonly defaults: LaunchSwitchDefaults,
  ) {}

  async write(id: SessionId, environment: Readonly<Record<string, string>>): Promise<void> {
    await this.stored.write(id, environment);
  }

  async read(id: SessionId): Promise<Readonly<Record<string, string>>> {
    const derived = await this.defaults(id).catch((): Readonly<Record<string, string>> => ({}));
    return { ...derived, ...(await this.stored.read(id)) };
  }
}
