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
} from '@ferretry/protocol';

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
