/**
 * Telling a RUNNING ferret that the instructions every agent gets have changed (docs/launch-settings.md,
 * "Instructions that changed since the launch").
 *
 * A harness reads its appended system prompt once, at launch. So a rule Ferretry tightens — the Agenda
 * rule, say — reached a ferret only when it next restarted, and a long-lived lead ferret could run for
 * days on the old words. Neither harness can re-read its system prompt mid-conversation, so the daemon
 * says the new words IN the conversation instead: once, for each always-on section
 * (`ALWAYS_ON_SECTIONS`) whose fingerprint differs from the one its launch recorded.
 *
 * - **An owner's message triggers it, and never carries it.** The owner's words go out exactly as typed;
 *   the note is its own message, queued right behind them, and says who sent it and what it is about as
 *   METADATA — Ferretry · Instructions, and the names of the sections it restates — never as a tag in its
 *   words (docs/message-delivery.md). Only an owner's message triggers it: a release must not start a turn
 *   for every idle ferret on the machine, and a teammate's message never does. A ferret nobody writes to
 *   does not need the rule until somebody does.
 * - **Once.** The note is queued under an id made from its words, so the queue never takes the same note
 *   twice; once it is durably queued the launch record says those sections were told, so the next message
 *   queues nothing. A restart records what it launched with, which is the same thing.
 * - **Only what can be proved.** A record with no fingerprint compares sizes; a session with no record at
 *   all (launched before records were kept) is told nothing, because nothing says what it has.
 *
 * Pure except {@link InstructionRefresh}, which reads and writes through its ports.
 */

import { type AlwaysOnSection, instructionDigest } from '@ferretry/fleet';
import type { LaunchInstructionSection, SessionLaunchInstructions } from '@ferretry/protocol';

/** The sender chip's feature for the note: the app says "Ferretry · Instructions", never a tag in the text. */
export const INSTRUCTIONS_FEATURE = 'Instructions';

/** Each always-on section by the name a person reads it under. */
const SECTION_NAMES: Readonly<Record<AlwaysOnSection['id'], string>> = {
  tools: 'Tools',
  settings: 'Settings',
  notify: 'Notify',
  board: 'Board',
  'sub-ferret': 'Sub-ferret',
};

/** The names of the sections a note restates, in prompt order: its metadata, for a row that names them. */
export function instructionSectionNames(sections: readonly AlwaysOnSection[]): readonly string[] {
  return sections.map(section => SECTION_NAMES[section.id]);
}

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

/** The note the ferret is sent: the new words, each section whole. */
export function instructionsUpdatedNote(sections: readonly AlwaysOnSection[]): string {
  const words = sections.map(section => section.text).join('\n\n');
  return `Ferretry changed part of the instructions you were started with. Follow these words in place of the matching part of your system prompt:\n\n${words}`;
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
  const kept = recorded.sections.filter(
    section => !ids.has(section.id as AlwaysOnSection['id']) && section.id !== 'attention',
  );
  const order = ['tools', 'settings', 'notify', 'board', 'sub-ferret'];
  const always = [...kept.filter(section => order.includes(section.id)), ...fresh].toSorted(
    (left, right) => order.indexOf(left.id) - order.indexOf(right.id),
  );
  return { ...recorded, sections: [...always, ...kept.filter(section => !order.includes(section.id))] };
}

/** What the refresh reads and writes. */
export interface InstructionRefreshPorts {
  /** The words every agent is told now: a sub-ferret's are not a lead's. */
  readonly sections: (subFerret: boolean) => readonly AlwaysOnSection[];
  /** What the session's launch was told, or `undefined` when nothing was recorded or it cannot be read. */
  readonly recorded: (sessionId: string) => Promise<SessionLaunchInstructions | undefined>;
  /** Rewrites the session's launch record under its lock; `undefined` from `update` leaves it alone. */
  readonly record: (
    sessionId: string,
    update: (current: SessionLaunchInstructions | undefined) => SessionLaunchInstructions | undefined,
  ) => Promise<void>;
  /**
   * Queues the note under an id made from the note's `digest`, with the names of the `sections` it restates as
   * its metadata; resolves once it is DURABLE, and takes the same digest once however often it is offered.
   */
  readonly queue: (sessionId: string, digest: string, note: string, sections: readonly string[]) => Promise<void>;
}

/**
 * Queues the note for a ferret whose instructions are out of date, and records them as told once it is
 * durably queued. Total: a record that cannot be read, a queue that fails or a record that cannot be
 * written never fails the owner's send this follows — a note that was not queued is not recorded, so the
 * next owner message offers it again.
 */
export class InstructionRefresh {
  constructor(private readonly ports: InstructionRefreshPorts) {}

  async queueIfStale(sessionId: string): Promise<void> {
    const recorded = await this.ports.recorded(sessionId).catch(() => undefined);
    const subFerret = recorded?.sections.some(section => section.id === 'sub-ferret') ?? false;
    const told = changedInstructions(recorded, this.ports.sections(subFerret));
    if (told.length === 0) return;
    const note = instructionsUpdatedNote(told);
    const queued = await this.ports.queue(sessionId, instructionDigest(note), note, instructionSectionNames(told)).then(
      () => true,
      () => false,
    );
    if (!queued) return;
    await this.ports
      .record(sessionId, current => (current === undefined ? undefined : recordTold(current, told)))
      .catch(() => undefined);
  }
}
