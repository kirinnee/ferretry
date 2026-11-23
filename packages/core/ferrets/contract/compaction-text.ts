/**
 * WHAT A FERRET DOES AFTER ITS CONTEXT IS COMPACTED (c58-o13, owner words on !A527: "inject compaction rule to include
 * agenda, tasks features so that they KNOW to re-absorb all the current task and agenda").
 *
 * A compaction keeps a summary and drops the rest, so a ferret can lose its assigned task, its board task, its open
 * agenda items and the messages it still owes a reply to. These are the two texts every harness hands its ferret, written
 * once: Claude prints them from hooks (`plugin-claude-code`), Codex carries them in its compact prompt (`plugin-codex`).
 *
 * Only core verbs are named here (a ferret's board task is re-read by Board's own instruction, which is given only while
 * Board is on, so these texts name no verb the `work` switch can turn off). The verbs are the ones the 5.0 CLI manifests
 * declare. `%s` stands for the ferret's session id (`FY_SESSION_ID`, which
 * every launch hands the pane); each harness fills it in its own way.
 */

/** The session id placeholder in {@link COMPACTION_REABSORB_LINES}: a `printf` conversion, replaced by the harness. */
export const COMPACTION_SESSION_PLACEHOLDER = '%s';

/** What the ferret reads again after a compaction. */
export const COMPACTION_REABSORB_LINES = [
  'You were just compacted, so part of your earlier context is gone. This is session %s.',
  'Before you continue, take back in everything you still owe:',
  '1. Your assignment: read your first turn again with `fy logs %s --turn 1`; it names the turn file to read and follow.',
  '2. Your open agenda items: `fy agenda ls`, then `fy agenda show <id>` for each.',
  '3. Messages you still owe a reply to: `fy transcript %s --tail`, then answer with `fy reply <id> <text>`.',
  'Then carry on with your next step. Do not ask the owner for what your assignment or agenda already says.',
] as const;

/** What the summary of a compaction must keep. */
export const COMPACTION_KEEP_LINES = [
  'When you summarise this conversation, keep: your assignment and how far you are; your open agenda item ids;',
  'every message you still owe a reply to and who sent it; and the branch and PR links you own. After the compaction',
  'you will be told to read the assignment, the agenda and the owed messages again, so the summary must name where each one is.',
] as const;

/** The re-read lines with the placeholder replaced by `session`. */
export const compactionReabsorbLines = (session: string): readonly string[] =>
  COMPACTION_REABSORB_LINES.map(line => line.replaceAll(COMPACTION_SESSION_PLACEHOLDER, session));
