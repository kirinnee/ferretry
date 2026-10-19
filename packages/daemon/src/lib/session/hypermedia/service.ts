/**
 * HYPERMEDIA, PER FERRET: whether a ferret is told it may explain with diagrams, drawings, interactive
 * pages and media (docs/hypermedia.md). `PATCH /v1/sessions/:sessionId/hypermedia`.
 *
 * The switch changes what a ferret is TOLD, and nothing it may do. It is carried exactly like passive
 * learning — `FY_HYPERMEDIA` in the launch environment, read by `fy mcp serve` — but unlike learning a
 * running ferret is never re-instructed: a nudge about presentation is not worth one of its turns, so
 * the change waits for the next launch and the answer says so.
 *
 * Two facts move together, under the session's own lock in the composition root: `config.hypermedia`
 * on the session document, which every surface reads, and the launch variable, which the pane reads.
 * Absent from both means ON, so a ferret started before the switch existed is instructed at its next
 * launch unless the owner turns it off first.
 */

/** What the switch needs to know about one ferret. */
export interface HypermediaFacts {
  /** The recorded switch; absent on a session started before it existed, which reads as on. */
  readonly enabled: boolean | undefined;
  /** Whether a process is running, so the change waits for its next launch. */
  readonly running: boolean;
}

export interface SessionHypermediaPorts {
  /** `undefined` when there is no such session. */
  facts(sessionId: string): Promise<HypermediaFacts | undefined>;
  /** Records the switch on the session document AND in its launch environment, stamped with `at`. */
  write(sessionId: string, enabled: boolean, at: string): Promise<void>;
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

  async set(sessionId: string, enabled: boolean): Promise<HypermediaOutcome> {
    const facts = await this.ports.facts(sessionId);
    if (facts === undefined) throw new SessionHypermediaError('not-found', `no session ${sessionId}`);
    await this.ports.write(sessionId, enabled, this.ports.now());
    const changed = (facts.enabled ?? true) !== enabled;
    return {
      restartRequired: changed && facts.running,
      note: hypermediaNote(enabled, changed, facts.running),
    };
  }
}
