/**
 * Where a command is on this machine, answered SYNCHRONOUSLY from what was looked up before.
 *
 * The catalogue asks for a command inside plain functions (`locate`, `commandExists`) and the kernel's
 * `paths.which` answers asynchronously, so the lookup is done ahead: {@link CommandCache.prime} resolves the names the
 * next read will ask about (the harness commands, every MCP server command), and {@link CommandCache.which} answers
 * from that. A name never primed is NOT found (the safe answer: a start is refused with "install it", never launched
 * on a guess), and a lookup older than the window is made again at the next prime, so a tool installed since is seen
 * by the next read without a daemon restart.
 */
export interface CommandSource {
  which(name: string): Promise<string | undefined>;
}

/** How long a lookup is trusted before the next prime asks again. */
const COMMAND_LOOKUP_WINDOW_MS = 10_000;

export class CommandCache {
  readonly #found = new Map<string, { readonly path: string | undefined; readonly at: number }>();

  constructor(
    private readonly source: CommandSource,
    private readonly now: () => number,
    private readonly windowMs: number = COMMAND_LOOKUP_WINDOW_MS,
  ) {}

  /** The path `name` resolved to at the last prime, or `undefined` when it was not found (or never looked up). */
  which(name: string): string | undefined {
    return this.#found.get(name)?.path;
  }

  /** Looks every name up whose answer is older than the window. A lookup that throws counts as not found. */
  async prime(names: Iterable<string>): Promise<void> {
    const now = this.now();
    const stale = [...new Set(names)].filter(name => {
      const known = this.#found.get(name);
      return known === undefined || now - known.at >= this.windowMs;
    });
    await Promise.all(
      stale.map(async name => {
        const path = await this.source.which(name).catch(() => undefined);
        this.#found.set(name, { path, at: now });
      }),
    );
  }
}
