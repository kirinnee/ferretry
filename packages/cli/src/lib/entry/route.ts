/**
 * Which part of the CLI one invocation loads.
 *
 * Every `fy` process used to evaluate the whole program — every command group, every protocol schema —
 * before it read its arguments, and the commands that LIVE LONGEST are the ones that use the least of
 * it: `fy mcp serve` runs for the life of every agent pane and `fy wait` for as long as a lead waits on a
 * sub-ferret. On one box that was ~50 processes at ~140 MB each, almost all of it code nobody ran. So
 * `bin/fy.ts` asks this function first and loads a SLICE — one command group on the same skeleton —
 * when the first argument names a command that slice owns, and the full program otherwise.
 *
 * THE RULE IS DELIBERATELY NARROW. Only a first argument that is exactly a sliced command name routes;
 * anything else — a global option before the command (`fy --as-owner wait …`), `fy help wait`, a
 * mistyped name, no arguments — loads the full program, which is the behaviour every command had
 * before slices existed. A wrong answer here can only cost memory, never change what a command does,
 * because each slice registers its group through the very function the full program calls.
 *
 * Pure: no IO, no globals.
 */

/** The slices `bin/fy.ts` can load instead of the full program. */
export type EntrySlice = 'reads' | 'mcp';

/**
 * The top-level commands each slice registers. Must equal what the slice's group puts on the program —
 * `tests/integration/entry/slices.test.ts` builds each slice and compares — so a command added to a
 * group without being listed here simply keeps loading the full program.
 */
export const SLICE_COMMANDS: Readonly<Record<EntrySlice, readonly string[]>> = {
  reads: ['attach', 'snapshot', 'logs', 'events', 'stream', 'wait'],
  mcp: ['mcp'],
};

/** The slice that owns this invocation, or `undefined` for the full program. `args` excludes argv[0..1]. */
export function entrySlice(args: readonly string[]): EntrySlice | undefined {
  const command = args[0];
  if (command === undefined) return undefined;
  for (const slice of Object.keys(SLICE_COMMANDS) as EntrySlice[]) {
    if (SLICE_COMMANDS[slice].includes(command)) return slice;
  }
  return undefined;
}
