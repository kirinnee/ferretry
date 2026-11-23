/**
 * WHAT A FERRET DOES AFTER ITS CONTEXT IS COMPACTED (c58-o13, owner words on !A527: "inject compaction rule to include
 * agenda, tasks features so that they KNOW to re-absorb all the current task and agenda").
 *
 * A compaction keeps a summary and drops the rest, so a ferret can lose its assigned task, its board task, its open
 * agenda items and the messages it still owes a reply to. These are the two texts every harness hands its ferret, written
 * once: Claude prints them from hooks (`plugin-claude-code`), Codex carries them in its compact prompt (`plugin-codex`).
 *
 * Core's own words name only core verbs. A ferret's board task is Board's: while Board is on (the `work` switch) it hands
 * the launch a `compaction` part ({@link CompactionExtras}, in Board's own words) and the texts below carry them; with
 * Board off no verb the switch can turn off is named. The verbs are the ones the 5.0 CLI manifests declare. `%s` stands
 * for the ferret's session id (`FY_SESSION_ID`, which every launch hands the pane); each harness fills it in its own way.
 */

import type { LaunchPart } from './kinds/launch.ts';

/** The session id placeholder in {@link COMPACTION_REABSORB_LINES}: a `printf` conversion, replaced by the harness. */
export const COMPACTION_SESSION_PLACEHOLDER = '%s';

/**
 * What a plugin adds to the two texts while it is on, in its own words (Board: a ferret's task, which the `work` switch
 * can turn off). It reaches a launch as the `compaction` launch part, so a harness composes the texts for THIS launch;
 * core owns the frame and never a plugin's words.
 */
export interface CompactionExtras {
  /** One more thing to take back in after a compaction, without its number (core numbers the list). */
  readonly reabsorb: string;
  /** One more thing the summary must keep, as a phrase that fits a list separated by `;`. */
  readonly keep: string;
  /** What the ferret is told it will read again, as a phrase that fits `the assignment, <reread>, the agenda`. */
  readonly reread: string;
}

/** The additions a launch's parts carry (the last `compaction` part wins), or none. */
export const compactionExtrasOf = (parts: readonly LaunchPart[]): CompactionExtras | undefined => {
  const part = parts.findLast(candidate => candidate.kind === 'compaction');
  return part === undefined || part.kind !== 'compaction'
    ? undefined
    : { reabsorb: part.reabsorb, keep: part.keep, reread: part.reread };
};

/** The re-read lines for one launch, the placeholder still in them: core's, with a plugin's item after the assignment. */
export const compactionReabsorbTemplate = (extras?: CompactionExtras): readonly string[] => [
  'You were just compacted, so part of your earlier context is gone. This is session %s.',
  'Before you continue, take back in everything you still owe:',
  ...[
    'Your assignment: read your first turn again with `fy logs %s --turn 1`; it names the turn file to read and follow.',
    ...(extras === undefined ? [] : [extras.reabsorb]),
    'Your open agenda items: `fy agenda ls`, then `fy agenda show <id>` for each.',
    'Messages you still owe a reply to: `fy transcript %s --tail`, then answer with `fy reply <id> <text>`.',
  ].map((item, at) => `${at + 1}. ${item}`),
  'Then carry on with your next step. Do not ask the owner for what your assignment or agenda already says.',
];

/** What the summary of a compaction must keep, for one launch. */
export const compactionKeepLines = (extras?: CompactionExtras): readonly string[] => [
  `When you summarise this conversation, keep: your assignment and how far you are;${extras === undefined ? '' : ` ${extras.keep};`} your open agenda item ids;`,
  'every message you still owe a reply to and who sent it; and the branch and PR links you own. After the compaction',
  `you will be told to read ${['the assignment', ...(extras === undefined ? [] : [extras.reread]), 'the agenda'].join(', ')} and the owed messages again, so the summary must name where each one is.`,
];

/** What the ferret reads again after a compaction with nothing added (every plugin off). */
export const COMPACTION_REABSORB_LINES = compactionReabsorbTemplate();

/** What the summary of a compaction must keep with nothing added (every plugin off). */
export const COMPACTION_KEEP_LINES = compactionKeepLines();

/** The re-read lines with the placeholder replaced by `session`. */
export const compactionReabsorbLines = (session: string, extras?: CompactionExtras): readonly string[] =>
  compactionReabsorbTemplate(extras).map(line => line.replaceAll(COMPACTION_SESSION_PLACEHOLDER, session));
