/**
 * The `statusLine.command` every Claude runtime is materialised with (a plumbing key, account-model §8.3), copied from
 * Logins' `claudeStatuslineCommand` (`plugins/logins/daemon/lib/credentials/usage.ts`): Logins' daemon library is not
 * part of its contract, so Runtimes keeps its own copy of the one spelling.
 *
 * THE ONE SPELLING, and it is a contract with `fy statusline`'s parser (`<binary> statusline [--then '<own command>']`):
 * when the person's own settings named a statusLine command it is CHAINED, never replaced, so `fy statusline` records
 * the reading and then runs theirs with the same stdin. `binary` is the CLI's binary name.
 */
import { shellQuote } from '../shell-quote.ts';
import type { ClaudeStatuslineCommand } from './adapt.ts';

/** The subcommand Claude's `statusLine.command` runs, and the option naming the person's own command. */
const STATUSLINE_SUBCOMMAND = 'statusline';
const STATUSLINE_THEN_OPTION = '--then';

/** The statusLine command for a runtime whose person's own command is `ownCommand` (absent: none). */
function claudeStatuslineCommand(binary: string, ownCommand?: string): string {
  const own = ownCommand?.trim() ?? '';
  const base = `${shellQuote(binary)} ${STATUSLINE_SUBCOMMAND}`;
  return own.length === 0 ? base : `${base} ${STATUSLINE_THEN_OPTION} ${shellQuote(own)}`;
}

/** {@link claudeStatuslineCommand} bound to a binary, as the catalogue's collaborator takes it. */
export const claudeStatuslineFor =
  (binary: string): ClaudeStatuslineCommand =>
  own =>
    claudeStatuslineCommand(binary, own);
