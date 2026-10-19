/**
 * PACK MODE, PER FERRET: whether a ferret is told it may delegate to sub-ferrets (docs/pack-mode.md).
 * `PATCH /v1/sessions/:sessionId/pack`.
 *
 * Carried exactly like hypermedia (`../hypermedia/service.ts`): `config.pack` on the session document,
 * which every surface reads, and `FY_PACK` in the launch environment, which the runtime wrapper turns
 * into a section of the appended system prompt. Absent from both means ON. A running ferret is never
 * re-instructed: the change waits for its next launch, and the answer says so. Switching it off also
 * makes `fy new` refuse this ferret `pack_off` at once.
 */

/** What the switch needs to know about one ferret. */
export interface PackSwitchFacts {
  /** The recorded switch; absent reads as on. */
  readonly enabled: boolean | undefined;
  readonly running: boolean;
}

export interface SessionPackPorts {
  /** `undefined` when there is no such session. */
  facts(sessionId: string): Promise<PackSwitchFacts | undefined>;
  /** Records the switch on the session document AND in its launch environment, stamped with `at`. */
  write(sessionId: string, enabled: boolean, at: string): Promise<void>;
  now(): string;
}

/** A refusal in this domain's own words; the route restates it in HTTP. */
export class SessionPackError extends Error {
  constructor(
    readonly reason: 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'SessionPackError';
  }
}

export interface PackSwitchOutcome {
  readonly restartRequired: boolean;
  readonly note: string;
}

/** The answer's sentence, said as what the ferret will be told and when. */
export function packSwitchNote(enabled: boolean, changed: boolean, running: boolean): string {
  const state = enabled ? 'on' : 'off';
  if (!changed) return `Pack mode was already ${state}.`;
  return running
    ? `Pack mode is ${state}. This ferret is running, so it is told when it restarts${enabled ? '' : '; it can start no sub-ferret from now'}.`
    : `Pack mode is ${state}; this ferret is not running, so it takes effect at its next launch.`;
}

export class SessionPackService {
  constructor(private readonly ports: SessionPackPorts) {}

  async set(sessionId: string, enabled: boolean): Promise<PackSwitchOutcome> {
    const facts = await this.ports.facts(sessionId);
    if (facts === undefined) throw new SessionPackError('not-found', `no session ${sessionId}`);
    await this.ports.write(sessionId, enabled, this.ports.now());
    const changed = (facts.enabled ?? true) !== enabled;
    return { restartRequired: changed && facts.running, note: packSwitchNote(enabled, changed, facts.running) };
  }
}
