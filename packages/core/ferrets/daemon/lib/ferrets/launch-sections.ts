/**
 * WHICH INSTRUCTION SECTIONS A FERRET WAS TOLD, AND WHETHER A LAUNCH NOW WOULD SAY THE SAME (U6; docs/launch-settings.md,
 * "Restarting ferrets whose instructions are out of date"). Today's `outdatedSections`, over what 5.0 launches with: the
 * instruction entries the plugins declared (`kernel.snapshot`), narrowed by the ferret's role and harness exactly as a launch
 * narrows them. A launch records each section's id and fingerprint (never its words); a ferret is OUTDATED when the
 * sections a launch would give it now differ from those it was told: a section added, dropped or reworded.
 *
 * FAIL SAFE: a ferret with no record is never outdated (nothing says what it was told), and a section id this build
 * does not list is left out of the answer rather than guessed. Pure.
 */
import type { InstructionEntry } from '@ferretry/kernel/contract';
import type { FerretRecord } from '../../../contract/index.ts';
import { type LaunchInstructionSectionId, LaunchInstructionSectionIdSchema } from '../protocol/session.ts';
import { instructionDigest } from '../session/peers/fleet.ts';

/** The entries a launch gives this ferret: its role and its harness decide (an entry that names none is for everyone). */
export function applicableInstructions(
  entries: readonly InstructionEntry[],
  ferret: Pick<FerretRecord, 'role' | 'harness'>,
): readonly InstructionEntry[] {
  return entries.filter(
    entry =>
      (entry.when.role === undefined || entry.when.role === 'any' || entry.when.role === ferret.role) &&
      (entry.when.harness === undefined || entry.when.harness === ferret.harness),
  );
}

/** Each section's id and fingerprint: what a launch records of what it told. */
export function sectionDigests(entries: readonly InstructionEntry[]): Readonly<Record<string, string>> {
  return Object.fromEntries(entries.map(entry => [entry.id, instructionDigest(entry.text)]));
}

/** The ids that differ between what a launch told and what one would tell now, in the order the ids are listed. */
export function outdatedSectionIds(
  told: Readonly<Record<string, string>> | undefined,
  now: Readonly<Record<string, string>>,
): readonly LaunchInstructionSectionId[] {
  if (told === undefined) return [];
  const ids = new Set([...Object.keys(told), ...Object.keys(now)]);
  const differing = [...ids].filter(id => told[id] !== now[id]);
  return LaunchInstructionSectionIdSchema.options.filter(id => differing.includes(id));
}
