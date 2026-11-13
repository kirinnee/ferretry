/**
 * HYPERMEDIA, PER FERRET: whether a ferret is told it may explain with diagrams, drawings, interactive
 * pages and media (docs/hypermedia.md). `PATCH /v1/ferrets/:ferretId/hypermedia`.
 *
 * The switch changes what a ferret is TOLD, and nothing it may do. It is carried exactly like Pack mode:
 * `FY_HYPERMEDIA` in the launch environment (this plugin's `launch.parts` contribution), read by `fy mcp serve`.
 * A running ferret is never re-instructed: a nudge about presentation is not worth one of its turns, so the change
 * waits for the next launch and the answer says so.
 *
 * Absent from the record means the mode's default (on for an interactive ferret, off for an auto one), so a
 * ferret started before the switch existed follows its mode at its next launch unless the owner set it.
 */

/** What the switch needs to know about one ferret. */
export interface HypermediaFacts {
  /** The switch as it reads now: the recorded value, else the default for the ferret's mode. */
  readonly enabled: boolean;
  /** Whether a process is running, so the change waits for its next launch. */
  readonly running: boolean;
}

export interface SessionHypermediaPorts {
  /** `undefined` when there is no such ferret. */
  facts(ferret: string): Promise<HypermediaFacts | undefined>;
  /** Records the switch, stamped with `at`. */
  write(ferret: string, enabled: boolean, at: string): Promise<void>;
  now(): string;
}

/** A refusal in this domain's own words; the route restates it in HTTP. */
export class SessionHypermediaError extends Error {
  constructor(
    readonly reason: 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'SessionHypermediaError';
  }
}

export interface HypermediaOutcome {
  readonly restartRequired: boolean;
  readonly note: string;
}

/** The answer's sentence, said as what the ferret will be told and when. */
export function hypermediaNote(enabled: boolean, changed: boolean, running: boolean): string {
  const state = enabled ? 'on' : 'off';
  if (!changed) return `Hypermedia was already ${state}.`;
  return running
    ? `Hypermedia is ${state}. This ferret is running, so it takes effect when the ferret restarts.`
    : `Hypermedia is ${state}; this ferret is not running, so it takes effect at its next launch.`;
}

export class SessionHypermediaService {
  constructor(private readonly ports: SessionHypermediaPorts) {}

  async set(ferret: string, enabled: boolean): Promise<HypermediaOutcome> {
    const facts = await this.ports.facts(ferret);
    if (facts === undefined) throw new SessionHypermediaError('not-found', `no ferret ${ferret}`);
    await this.ports.write(ferret, enabled, this.ports.now());
    const changed = facts.enabled !== enabled;
    return {
      restartRequired: changed && facts.running,
      note: hypermediaNote(enabled, changed, facts.running),
    };
  }
}

/** Absent from the record means the mode's default: on for an interactive ferret, off for an automatic one. */
export const hypermediaDefault = (mode: 'auto' | 'interactive' | undefined): boolean => mode === 'interactive';
