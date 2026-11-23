/**
 * WHAT A CLAUDE FERRET DOES AFTER ITS CONTEXT IS COMPACTED (c58-o13, owner words on !A527: "inject compaction rule to include
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
 * there): `agenda ls`, `agenda show`, `logs --turn`, `transcript --tail`, `reply`. The only
 * ferret-specific value is `FY_SESSION_ID`, which every launch hands the pane; nothing secret is read or printed.
 */

import {
  type CompactionExtras,
  COMPACTION_KEEP_LINES,
  COMPACTION_REABSORB_LINES,
  compactionKeepLines,
  compactionReabsorbTemplate,
} from '@ferretry/core-ferrets/contract';

/** The matcher that fires a `SessionStart` hook only for the start a compaction makes. */
export const CLAUDE_COMPACT_MATCHER = 'compact';

/** `printf` argument for the session id: the launch's own, or a plain word when a pane has none. */
const SESSION = '"${FY_SESSION_ID:-<your session id>}"';

/** What the ferret reads again after a compaction: the one text every harness hands its ferret. `%s` is its session id (the same argument, three times). */
export const CLAUDE_REABSORB_LINES = COMPACTION_REABSORB_LINES;

/** What the summary must keep, printed before the compaction. */
export const CLAUDE_KEEP_LINES = COMPACTION_KEEP_LINES;

const print = (lines: readonly string[], args: string): string => `printf '${lines.join('\\n')}\\n' ${args}; exit 0`;

export const CLAUDE_REABSORB_COMMAND = print(CLAUDE_REABSORB_LINES, [SESSION, SESSION, SESSION].join(' '));
export const CLAUDE_KEEP_COMMAND = print(CLAUDE_KEEP_LINES, '');

/**
 * The two hooks for ONE launch: with a plugin's `extras` (Board's task lines while Board is on) the payloads carry them,
 * without any they name core's verbs only. The hooks are the same two commands either way, so only their text differs.
 */
export const claudeCompactionHooks = (extras?: CompactionExtras) => ({
  PreCompact: [{ hooks: [{ type: 'command', command: print(compactionKeepLines(extras), '') }] }],
  SessionStart: [
    {
      matcher: CLAUDE_COMPACT_MATCHER,
      hooks: [
        {
          type: 'command',
          command: print(compactionReabsorbTemplate(extras), [SESSION, SESSION, SESSION].join(' ')),
        },
      ],
    },
  ],
});

/** The hooks with nothing added: what a launch gets while every plugin that adds to them is off. */
export const CLAUDE_COMPACTION_HOOKS = claudeCompactionHooks();
