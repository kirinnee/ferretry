/**
 * WHAT A FERRET DOES AFTER ITS CONTEXT IS COMPACTED (c58-o13, owner words on !A527: "inject compaction rule to include
 * agenda, tasks features so that they KNOW to re-absorb all the current task and agenda").
 *
 * A compaction keeps a summary and drops the rest, so a ferret can lose its assigned task, its card, its open agenda
 * items and the messages it still owes a reply to. Two hooks in the fixed layer say so, both Claude's own supported
 * mechanism (the owner's v4 setup used the same pair: a `PreCompact` `cat` and a `SessionStart` script):
 *
 * - `PreCompact` (no matcher: manual and auto) prints what the SUMMARY must keep, which Claude takes as the compaction's
 *   custom instructions;
 * - `SessionStart` with the matcher `compact` prints, after the compaction, what to read again; a `SessionStart`
 *   hook's stdout becomes context the ferret reads.
 *
 * The verbs are the ones the 5.0 CLI manifests declare (a CLI test reads the registry and fails on a verb that is not
 * there): `task show`, `board status`, `agenda ls`, `agenda show`, `logs --turn`, `transcript --tail`, `reply`. The only
 * ferret-specific value is `FY_SESSION_ID`, which every launch hands the pane; nothing secret is read or printed.
 */

/** The matcher that fires a `SessionStart` hook only for the start a compaction makes. */
export const CLAUDE_COMPACT_MATCHER = 'compact';

/** `printf` argument for the session id: the launch's own, or a plain word when a pane has none. */
const SESSION = '"${FY_SESSION_ID:-<your session id>}"';

/** What the ferret reads again after a compaction. `%s` is its session id (the same argument, twice). */
export const CLAUDE_REABSORB_LINES = [
  'You were just compacted, so part of your earlier context is gone. This is session %s.',
  'Before you continue, take back in everything you still owe:',
  '1. Your assigned task: read your first turn again with `fy logs %s --turn 1`; it names the turn file to read and follow.',
  '2. Your board task, if you have one: `fy task show <task id>` (add --yaml for the editable form); if you do not know the id, `fy board status` says whether the board is on.',
  '3. Your open agenda items: `fy agenda ls`, then `fy agenda show <id>` for each.',
  '4. Messages you still owe a reply to: `fy transcript %s --tail`, then answer with `fy reply <id> <text>`.',
  'Then carry on with your next step. Do not ask the owner for what your task or agenda already says.',
] as const;

/** What the summary must keep, printed before the compaction. */
export const CLAUDE_KEEP_LINES = [
  'When you summarise this conversation, keep: the assigned task and how far you are; your card id and its status',
  '(now, done so far, next); your open agenda item ids; every message you still owe a reply to and who sent it;',
  'and the branch and PR links you own. After the compaction you will be told to read the task, the card, the agenda and',
  'the owed messages again, so the summary must name where each one is.',
] as const;

const print = (lines: readonly string[], args: string): string => `printf '${lines.join('\\n')}\\n' ${args}; exit 0`;

export const CLAUDE_REABSORB_COMMAND = print(CLAUDE_REABSORB_LINES, [SESSION, SESSION, SESSION].join(' '));
export const CLAUDE_KEEP_COMMAND = print(CLAUDE_KEEP_LINES, '');

export const CLAUDE_COMPACTION_HOOKS = {
  PreCompact: [{ hooks: [{ type: 'command', command: CLAUDE_KEEP_COMMAND }] }],
  SessionStart: [{ matcher: CLAUDE_COMPACT_MATCHER, hooks: [{ type: 'command', command: CLAUDE_REABSORB_COMMAND }] }],
};
