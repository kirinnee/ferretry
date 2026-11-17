/**
 * The option guard of `fy mcp serve`, which runs on the slim entry (`bin/mcp-serve.ts`) and so never reaches the full
 * router's check (`run.ts` → `option-guard.ts`). It is the same rule, run over the verb's own declared options.
 *
 * `mcp serve` declares no option of its own: every argv Ferretry writes for it is the bare words (`FERRETRY_MCP_ARGS`
 * in the fixed layer of every runtime, Claude's `--mcp-config`, Codex's `mcp_servers.ferretry.args`; the Claude channel
 * is switched by an environment variable, not a flag). `tests/unit/slim-entry.test.ts` proves this list is exactly what
 * the mcp manifest declares for the verb, so the two cannot drift.
 *
 * Pure: no IO, no globals; it loads nothing the slim entry does not already hold.
 */
import type { VerbOptionDecl } from '@ferretry/kernel/manifest';
import { parseArgs } from '../argv.ts';
import { undeclaredOption } from '../option-guard.ts';

/** The owner of the verb and its line, as the manifest names them. */
const OWNER = 'mcp';
const LINE = 'mcp serve';

/** The options `mcp serve` declares: none (the shell-wide `--help`, `-h` and `--as-owner` are accepted besides). */
export const SERVE_OPTIONS: readonly Pick<VerbOptionDecl, 'flag'>[] = [];

/** The first option in `rest` (the words after `mcp serve`) the verb does not declare, as typed; undefined when none. */
export function unknownServeOption(rest: readonly string[]): string | undefined {
  return undeclaredOption(OWNER, LINE, SERVE_OPTIONS, parseArgs(rest));
}
