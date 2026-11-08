import type { FerretId, FerretRecord } from '../../../contract/index.ts';
import { LAUNCH_SWITCH_VARIABLES } from '../../../contract/index.ts';

/** What a ferret's launch environment is kept in: the switches it was launched with, per ferret. */
export interface LaunchEnvironmentRecord {
  read(ferret: FerretId): Promise<Readonly<Record<string, string>>>;
  write(ferret: FerretId, environment: Readonly<Record<string, string>>): Promise<void>;
}

/** The per-ferret switches a ferret's record implies, for a launch whose environment never stored them. */
export type LaunchSwitchDefaults = (ferret: FerretId) => Promise<Readonly<Record<string, string>>>;

/**
 * What a pane is LAUNCHED with, as `instructions` reports it: the stored environment over the per-ferret switches the
 * record implies (today's `LaunchEnvironmentStore`, `launch-environment.ts`). The ONE reader: nothing answers from
 * memory, so a restarted daemon answers what it answered before.
 *
 * A stored switch always wins (it is what the last launch handed the pane); only a switch the store never recorded is
 * derived. Defaults that cannot be resolved derive nothing, because a read must never fail on a switch it was not
 * given. Writes go straight through: what is stored is only ever what a launch said.
 */
export class LaunchEnvironmentStore implements LaunchEnvironmentRecord {
  constructor(
    private readonly stored: LaunchEnvironmentRecord,
    private readonly defaults: LaunchSwitchDefaults,
  ) {}

  async write(ferret: FerretId, environment: Readonly<Record<string, string>>): Promise<void> {
    await this.stored.write(ferret, environment);
  }

  async read(ferret: FerretId): Promise<Readonly<Record<string, string>>> {
    const derived = await this.defaults(ferret).catch((): Readonly<Record<string, string>> => ({}));
    return { ...derived, ...(await this.stored.read(ferret)) };
  }
}

/**
 * The switches Ferrets itself can derive from a ferret's record: its mode. Every section switch belongs to the plugin
 * that contributes it as a launch part (Pack and Conversation today), so none is guessed here; a section whose owner does not contribute
 * yet is simply absent, and `instructions` then says the pane was not handed the switches.
 */
export function switchesOfRecord(record: FerretRecord | undefined): Readonly<Record<string, string>> {
  return record?.mode === undefined ? {} : { FY_SESSION_MODE: record.mode };
}

/** The launch variables a launch records: the section switches and the mode, as the launch put them in its environment. */
export function recordedSwitches(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    LAUNCH_SWITCH_VARIABLES.flatMap(name => (environment[name] === undefined ? [] : [[name, environment[name]]])),
  );
}
