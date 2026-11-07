/**
 * Whether a running ferret carries instructions a launch now would not give it (docs/launch-settings.md,
 * "Restarting ferrets whose instructions are out of date").
 *
 * The comparison is between two {@link SessionLaunchInstructions}: what the launch RECORDED (kept current by
 * the live instructions-updated note, Ferretry · Instructions, which re-records the always-on sections it
 * told), and what the very renderer a launch uses (`launchInstructions` in `@ferretry/fleet`) answers for
 * the environment a relaunch would build now. So a section the live note already delivered is not outdated, and one only a
 * restart can deliver is.
 *
 * A section differs when it is on in one and not the other (a switch flipped since the launch), or its
 * words changed. Words are compared by fingerprint, or by size when the record is older than fingerprints.
 * A session with no record is never outdated: nothing says what it has.
 */

import type {
  LaunchInstructionSection,
  LaunchInstructionSectionId,
  SessionLaunchInstructions,
} from '../../protocol/session.ts';
import type { SessionId } from '../../session-id.ts';
import { sessionPaneEnvironment } from '../lifecycle/policy.ts';

/** A launch record made before the rename called the notify section `attention`. */
const canonical = (id: LaunchInstructionSectionId): LaunchInstructionSectionId => (id === 'attention' ? 'notify' : id);

const same = (told: LaunchInstructionSection, now: LaunchInstructionSection): boolean =>
  told.digest === undefined || now.digest === undefined ? told.chars === now.chars : told.digest === now.digest;

/** The ids of the sections that differ, in prompt order — empty when the ferret is current or unrecorded. */
export function outdatedSections(
  recorded: SessionLaunchInstructions | undefined,
  now: SessionLaunchInstructions,
): readonly LaunchInstructionSectionId[] {
  if (recorded === undefined) return [];
  const told = new Map(recorded.sections.map(section => [canonical(section.id), section]));
  const current = new Map(now.sections.map(section => [canonical(section.id), section]));
  const ids = [...new Set([...current.keys(), ...told.keys()])];
  const order = ['tools', 'settings', 'notify', 'board', 'hypermedia', 'pack', 'agenda', 'learning'];
  return ids
    .filter(id => {
      const before = told.get(id);
      const after = current.get(id);
      return before === undefined || after === undefined || !same(before, after);
    })
    .toSorted((left, right) => order.indexOf(left) - order.indexOf(right));
}

/**
 * The environment a relaunch would give the pane, as far as instructions read it: the stored variables with the
 * launch's own derivations on top (`sessionPaneEnvironment` — notably the mode's hypermedia default, which a
 * ferret whose switch was never written only gets from there). Comparing against the STORED variables alone
 * called every such interactive ferret "out of date: hypermedia" right after the restart that had just fixed it.
 */
export function relaunchInstructionEnvironment(
  id: SessionId,
  stored: Readonly<Record<string, string>>,
  mode: 'auto' | 'interactive',
): Readonly<Record<string, string>> {
  return sessionPaneEnvironment(id, stored, mode);
}
