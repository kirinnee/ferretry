import type { FerretDetails, FerretId, FerretRecord } from '../../../contract/index.ts';
import { LAUNCH_SWITCH_VARIABLES, SUB_FERRET_ENV } from '../../../contract/index.ts';
import { effectiveMode } from '../registry/registry.ts';
import { HYPERMEDIA_ENV, launchMode } from '../session/peers/fleet.ts';

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
 * that contributes it as a launch part (Pack and Conversation today), so none is guessed here. A section whose owner
 * does not contribute yet is simply absent from the record, and `instructions` reads it as off: Pack always records
 * `FY_PACK`, so the record is known, and a switch it does not hold was not handed to the pane.
 */
export function switchesOfRecord(
  record: FerretRecord | undefined,
  details?: FerretDetails,
): Readonly<Record<string, string>> {
  // No mode on the record is `auto` (`launchMode`), exactly what the launch handed the pane, so they agree.
  return record === undefined ? {} : sessionModeSwitch(launchMode(effectiveMode(record, details)));
}

/**
 * The mode a pane is handed (`FY_SESSION_MODE`, v4 parity): the wrappers and `instructions` read it. The ONE spelling
 * of it, shared by what a launch puts in the pane's environment and what the record implies, so the stored switch and
 * the derived one always agree and a launch never makes a ferret read as changed. A caller resolves a record's mode
 * through `launchMode` first (absent is `auto`, owned there); an unresolved one hands the pane nothing.
 */
export function sessionModeSwitch(mode: FerretRecord['mode']): Readonly<Record<string, string>> {
  return mode === undefined ? {} : { FY_SESSION_MODE: mode };
}

/**
 * The per-ferret switch a LAUNCH decides itself, from the ferret's mode: Hypermedia is ON for an interactive ferret and
 * OFF for an auto one (a worker, a warden, a miner; docs/hypermedia.md). It goes into the launch environment FIRST, so
 * an owner's switch (Conversation's `conversation-hypermedia` part) still wins, and the pane is handed it and
 * `instructions` reads it back from the record. A ferret with no mode is an auto one (the start's own default).
 */
export function modeSwitchDefaults(mode: FerretRecord['mode']): Readonly<Record<string, string>> {
  return { [HYPERMEDIA_ENV]: mode === 'interactive' ? '1' : '0' };
}

/**
 * Whether the pane is a sub-ferret (`FY_SUB_FERRET`), from the record's `role` and `parent`: a helper is one, and so is
 * any ferret with a parent (a start can POST `role: lead` beside the parent it is forced to have), a lead with none is
 * not. The same rule as `needsHelperAdmission` (ferrets/helper-admission.ts), and the one every daemon limit reads. The
 * wrapper reads it to swap the lead's Notify and Board rules for the Sub-ferret section and to leave the Agenda section
 * out. The ONE spelling, put in the environment AFTER the parts, so no part or login file can move it: it is the
 * record's own fact. A helper started with no parent (a Pack's clean-up builder) is limited the same way, and `role`
 * defaults to `helper` whenever a start names a parent.
 */
export function subFerretSwitch(
  role: FerretRecord['role'],
  parent?: FerretRecord['parent'],
): Readonly<Record<string, string>> {
  return { [SUB_FERRET_ENV]: role === 'helper' || parent !== undefined ? '1' : '0' };
}

/** The launch variables a launch records: the section switches and the mode, as the launch put them in its environment. */
export function recordedSwitches(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    LAUNCH_SWITCH_VARIABLES.flatMap(name => (environment[name] === undefined ? [] : [[name, environment[name]]])),
  );
}
