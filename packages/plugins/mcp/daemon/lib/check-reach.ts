import type { McpProbeAnswer, McpProbeSpec } from './inventory/check.ts';

/**
 * What a CHECK may start: the one program of the one server being checked, for as long as that check runs.
 *
 * A check starts the owner's own stdio command (any program, as the harness would), so the manifest cannot name it in
 * advance. The `mcp-check` spawn resolver answers only what was handed to {@link permit} and not yet released: the check
 * service has already refused an unapproved or disabled project command before it builds the spec the probe receives,
 * so a command arrives here only when the harness itself would run it. Nothing else of this plugin can start a program.
 * The answer is the exact command; a program that names a wildcard is never allowed (the kernel's own rule).
 */
export class CheckSpawnReach {
  private readonly held = new Map<string, number>();

  /** Allow `program` until the returned call is made (once; further calls do nothing). */
  permit(program: string): () => void {
    this.held.set(program, (this.held.get(program) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.held.get(program) ?? 1) - 1;
      if (left <= 0) this.held.delete(program);
      else this.held.set(program, left);
    };
  }

  /** What the resolver answers now. */
  programs(): readonly string[] {
    return [...this.held.keys()];
  }
}

/** What a probe needs to be told of the world before it reaches out. */
interface Reaching {
  probe(spec: McpProbeSpec, signal: AbortSignal): Promise<McpProbeAnswer>;
}

/**
 * A probe that first makes the machine's reach current: a stdio command is allowed for the length of its own probe, and a
 * web address is reached after the servers' hosts are listed afresh (the `mcp-sign-in` resolver answers what was last
 * listed, and a check may be the first thing to ask).
 */
export class ReachedProbe implements Reaching {
  constructor(
    private readonly inner: Reaching,
    private readonly spawn: CheckSpawnReach,
    private readonly listServers: () => Promise<unknown>,
  ) {}

  async probe(spec: McpProbeSpec, signal: AbortSignal): Promise<McpProbeAnswer> {
    if (spec.transport === 'stdio') {
      const release = this.spawn.permit(spec.command);
      try {
        return await this.inner.probe(spec, signal);
      } finally {
        release();
      }
    }
    await this.listServers().catch(() => undefined);
    return await this.inner.probe(spec, signal);
  }
}
