/**
 * Telling a RUNNING ferret that the instructions every agent gets have changed (docs/launch-settings.md,
 * "Instructions that changed since the launch").
 *
 * A harness reads its appended system prompt once, at launch. So a rule Ferretry tightens — the Attention
 * rule, say — reached a ferret only when it next restarted, and a long-lived lead ferret could run for
 * days on the old words. Neither harness can re-read its system prompt mid-conversation, so the daemon
 * says the new words IN the conversation instead: once, appended to the owner's next message, for each
 * always-on section (`ALWAYS_ON_SECTIONS`) whose fingerprint differs from the one its launch recorded.
 *
 * - **The owner's next message carries it**, never a message of its own: a note alone would start a turn
 *   for every ferret on the machine the moment a release lands. A ferret nobody writes to does not need
 *   the rule until somebody does.
 * - **Once.** After the message is accepted, the launch record says those sections were told, so the next
 *   message carries nothing. A restart records what it launched with, which is the same thing.
 * - **Only what can be proved.** A record with no fingerprint compares sizes; a session with no record at
 *   all (launched before records were kept) is told nothing, because nothing says what it has.
 *
 * Pure except {@link InstructionRefresh}, which reads and writes through its ports.
 */

import { type AlwaysOnSection, instructionDigest } from '@ferretry/fleet';
import type { LaunchInstructionSection, SessionLaunchInstructions } from '@ferretry/protocol';

/** The first words of the note, so a reader (and a test) can tell it from the owner's own. */
export const INSTRUCTIONS_UPDATED_MARK = '[instructions updated]';

/** Whether a recorded section still matches the words every agent is told now. */
const current = (told: LaunchInstructionSection, section: AlwaysOnSection): boolean =>
  told.digest === undefined ? told.chars === section.text.length : told.digest === instructionDigest(section.text);

/**
 * The always-on sections whose words differ from what this launch recorded, in prompt order — nothing for a
 * session with no record. A section the record lacks is one the ferret was never told, so it is included.
 */
export function changedInstructions(
  recorded: SessionLaunchInstructions | undefined,
  sections: readonly AlwaysOnSection[],
): readonly AlwaysOnSection[] {
  if (recorded === undefined) return [];
  return sections.filter(section => {
    const told = recorded.sections.find(candidate => candidate.id === section.id);
    return told === undefined || !current(told, section);
  });
}

/** The note appended to the owner's message: the new words, each section whole. */
export function instructionsUpdatedNote(sections: readonly AlwaysOnSection[]): string {
  const words = sections.map(section => section.text).join('\n\n');
  return `${INSTRUCTIONS_UPDATED_MARK} Ferretry changed part of the instructions you were started with. Follow these words in place of the matching part of your system prompt:\n\n${words}`;
}

/**
 * The launch record once `told` has been said: each told section carries its current size and fingerprint,
 * in prompt order ahead of the per-ferret sections, which are left exactly as launched.
 */
export function recordTold(
  recorded: SessionLaunchInstructions,
  told: readonly AlwaysOnSection[],
): SessionLaunchInstructions {
  const ids = new Set(told.map(section => section.id));
  const fresh = told.map(section => ({
    id: section.id,
    chars: section.text.length,
    digest: instructionDigest(section.text),
  }));
  const kept = recorded.sections.filter(section => !ids.has(section.id as AlwaysOnSection['id']));
  const order = ['tools', 'settings', 'attention'];
  const always = [...kept.filter(section => order.includes(section.id)), ...fresh].toSorted(
    (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
  );
  return { ...recorded, sections: [...always, ...kept.filter(section => !order.includes(section.id))] };
}

/** What the refresh reads and writes. */
export interface InstructionRefreshPorts {
  /** The words every agent is told now. */
  readonly sections: () => readonly AlwaysOnSection[];
  /** What the session's launch was told, or `undefined` when nothing was recorded or it cannot be read. */
  readonly recorded: (sessionId: string) => Promise<SessionLaunchInstructions | undefined>;
  /** Rewrites the session's launch record under its lock; `undefined` from `update` leaves it alone. */
  readonly record: (
    sessionId: string,
    update: (current: SessionLaunchInstructions | undefined) => SessionLaunchInstructions | undefined,
  ) => Promise<void>;
}

/** An owner message with the note appended, and the sections it tells. */
export interface RefreshedMessage {
  readonly message: string;
  readonly told: readonly AlwaysOnSection[];
}

/**
 * Appends the note to an owner's message when the ferret's instructions are out of date, and records them
 * as told once the message is accepted. Total on the way in: a record that cannot be read leaves the
 * message as written, because a person's words must never be refused for the sake of a note.
 */
export class InstructionRefresh {
  constructor(private readonly ports: InstructionRefreshPorts) {}

  async prepare(sessionId: string, message: string): Promise<RefreshedMessage> {
    const recorded = await this.ports.recorded(sessionId).catch(() => undefined);
    const told = changedInstructions(recorded, this.ports.sections());
    if (told.length === 0) return { message, told };
    return { message: `${message}\n\n${instructionsUpdatedNote(told)}`, told };
  }

  /** Records the told sections; never able to fail the send it follows. */
  async settle(sessionId: string, refreshed: RefreshedMessage): Promise<void> {
    if (refreshed.told.length === 0) return;
    await this.ports
      .record(sessionId, recorded => (recorded === undefined ? undefined : recordTold(recorded, refreshed.told)))
      .catch(() => undefined);
  }
}
