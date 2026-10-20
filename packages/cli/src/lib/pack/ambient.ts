/**
 * Which ferret a `fy new` runs inside — the sub-ferret's parent (docs/pack-mode.md).
 *
 * The daemon puts `FY_SESSION_ID` into a ferret's pane environment, and every shell the agent opens
 * inherits it — unless the agent's harness, a sandbox or a subshell drops it. The pane's tmux SESSION
 * keeps it either way (the daemon starts the pane with `-e FY_SESSION_ID=…`), so the CLI asks tmux when
 * the variable is gone and `TMUX` says it is inside one. A sub-ferret started with no parent recorded
 * would land at the top of the tree, in whatever folder the shell happened to be in.
 */

/** The value of `name` in `tmux show-environment <name>` output, or `undefined` when it is unset or absent. */
export function tmuxEnvironmentValue(output: string, name: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    if (!line.startsWith(`${name}=`)) continue;
    const value = line.slice(name.length + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** Runs one command and answers its stdout, or `undefined` when it could not run or failed. */
export type CommandOutput = (argv: readonly string[]) => Promise<string | undefined>;

/** The ambient session: `FY_SESSION_ID`, else the tmux session's own copy, else none. */
export async function ambientSession(
  environment: Readonly<Record<string, string | undefined>>,
  run: CommandOutput,
): Promise<string | undefined> {
  const own = environment.FY_SESSION_ID?.trim();
  if (own !== undefined && own !== '') return own;
  if ((environment.TMUX ?? '') === '') return undefined;
  const output = await run(['tmux', 'show-environment', 'FY_SESSION_ID']);
  return output === undefined ? undefined : tmuxEnvironmentValue(output, 'FY_SESSION_ID');
}
