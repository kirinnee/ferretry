/**
 * Which programs a check may start: the `mcp-commands` spawn resolver's whole answer.
 *
 * The kernel refuses every program a manifest does not declare, and the programs MCP starts are the owner's own
 * servers' commands, which no manifest can list. So the allowance is DATA, and only this much of it:
 *
 * 1. the `command` of each server configured in `config/mcp/*.yaml` (the owner's own files, as they are in effect);
 * 2. the command of the one server a check is starting NOW (a user-scope or project server the inventory resolved),
 *    from the moment it is allowed until the check ends, however it ends.
 *
 * No wildcard, no pattern, nothing a ferret can add: a project command still needs the harness's approval before a
 * check runs it (`blockedBy`), and the second set is released when the check is over.
 */
export class AllowedCommands {
  readonly #running = new Map<string, number>();

  constructor(private readonly configured: () => readonly string[]) {}

  /** Allows `command` until the returned call is made (once; a second call does nothing). */
  allow(command: string): () => void {
    this.#running.set(command, (this.#running.get(command) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#running.get(command) ?? 1) - 1;
      if (left <= 0) this.#running.delete(command);
      else this.#running.set(command, left);
    };
  }

  /** The programs allowed now: asked by the kernel at every start, with nothing about the request. */
  programs(): readonly string[] {
    return [...new Set([...this.configured(), ...this.#running.keys()])];
  }
}
