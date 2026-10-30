/**
 * THE ROUTING LINE, DERIVED ONCE PER CONFIGURATION — NOT ONCE PER FERRET PER LOOK.
 *
 * A Pack ferret's launch environment carries the routing prompt as one line (`FY_PACK_ROUTING`), and that
 * environment is not only built at a launch: every running ferret's session view asks whether a launch now
 * would tell it something different ("outdated"), and answers it by building the very environment a
 * relaunch would. Deriving the line reads the Pack settings, the model catalogs and the fleet's runtime
 * catalogue — which reads every session's state — so a roster of forty running ferrets derived it several
 * times a second, each time from the same files, and that held the main thread.
 *
 * The line is the same for every ferret, so it is derived once and kept while its **generation** holds: the
 * configuration load in effect, compared by identity, which a saved file replaces — so a launch after a
 * saved routing prompt still hears the new one. Concurrent callers share the derivation in flight.
 *
 * A GENERATION IS NEVER TRUSTED FOREVER. What else the line reads — a newer published model catalog, a
 * local model installed, a runtime id written — moves no configuration file, so a kept line is derived
 * again at the latest {@link PackRoutingKeepPorts.maxAgeMs} after it was. A derivation that fails is not
 * kept: the next caller asks again.
 */

export interface PackRoutingKeepPorts {
  /** What moves when a saved file can have changed the line: compared by identity, never inspected. */
  generation(): Promise<unknown>;
  /** The costly derivation the keep exists to share. */
  derive(): Promise<string>;
  now(): number;
  /** The longest a line is kept, however still its generation is. */
  readonly maxAgeMs: number;
}

interface KeptLine {
  readonly generation: unknown;
  readonly at: number;
  readonly line: Promise<string>;
}

/** How long a routing line is kept while the configuration holds, at most. */
export const PACK_ROUTING_MAX_AGE_MS = 30_000;

export class PackRoutingKeep {
  #kept: KeptLine | undefined;

  constructor(private readonly ports: PackRoutingKeepPorts) {}

  /** The line as of the configuration in effect: the kept one while it holds and is young enough. */
  async line(): Promise<string> {
    const generation = await this.ports.generation();
    const now = this.ports.now();
    const kept = this.#kept;
    if (kept !== undefined && kept.generation === generation && now - kept.at < this.ports.maxAgeMs)
      return await kept.line;
    const fresh: KeptLine = {
      generation,
      at: now,
      line: this.ports.derive().catch((error: unknown) => {
        if (this.#kept === fresh) this.#kept = undefined;
        throw error;
      }),
    };
    this.#kept = fresh;
    return await fresh.line;
  }
}
