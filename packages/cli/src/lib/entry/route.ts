/**
 * Which part of the CLI an invocation needs, decided from its words alone, before anything heavy is loaded. Pure: the
 * binary's entry (`bin/fy.ts`) asks this first and then loads exactly one composition root.
 *
 * One invocation is narrowed: `fy mcp serve`. Every agent runtime starts one and keeps it for the life of its pane, so a
 * machine running thirty ferrets runs thirty of them; each used to hold the whole command registry to forward tool calls.
 * It is also the one command that must NEVER act as the owner: it is a ferret's tools server, so the slim root
 * (`bin/mcp-serve.ts`) authenticates with the pane credential and nothing else, whatever else is in the environment or
 * on the line. That is why the route does not depend on the environment: an owner credential (`FY_TOKEN`) or a missing
 * pane credential must reach the slim root and be refused there, not fall through to a path that would use it.
 *
 * What stays on the full path is only what never connects: help, version and an option the router refuses by name.
 */

export type EntrySlice = 'mcp-serve' | 'full';

/** What `mcp serve` was asked with, for the slim root to refuse what it must. */
export interface ServeInvocation {
  /** `--as-owner` before the verb: refused by the slim root, which acts as the pane's ferret only. */
  readonly asOwner: boolean;
}

/** The `mcp serve` invocation `args` (without the runtime and script) spell, or undefined when they spell another. */
export function mcpServeInvocation(args: readonly string[]): ServeInvocation | undefined {
  let asOwner = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith('-')) break;
    // Any other leading flag (`--help`, `--version`, an unknown one) is answered or refused by the router before it connects.
    if (token === '--as-owner') asOwner = true;
    else return undefined;
  }
  if (args[index] !== 'mcp' || args[index + 1] !== 'serve') return undefined;
  // `--help` or `-h` anywhere after the verb (before `--`) is answered by the router before it connects.
  for (const token of args.slice(index + 2)) {
    if (token === '--') break;
    if (token === '--help' || token === '-h') return undefined;
  }
  return { asOwner };
}

export function entrySlice(args: readonly string[]): EntrySlice {
  return mcpServeInvocation(args) === undefined ? 'full' : 'mcp-serve';
}
