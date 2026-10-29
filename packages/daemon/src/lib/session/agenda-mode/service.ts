/**
 * AGENDA MODE, PER FERRET: whether a ferret keeps an agenda of what only the owner can do or decide
 * (docs/agenda.md). `GET` and `PATCH /v1/sessions/:sessionId/agenda-mode`. OFF unless the owner (or the
 * one-time migration, docs/notifications.md § Migration) turned it on.
 *
 * The switch changes what a ferret is TOLD. It is carried exactly like Pack and hypermedia: `config.agenda` on the
 * session document, which every surface reads (the summary's `agendaMode` follows it), and `FY_AGENDA` in the launch
 * environment, read by the instruction wrapper. A running ferret is never re-instructed — a change of instructions is
 * not worth one of its turns — so the change waits for the next launch and the answer says so.
 */

/** What the switch needs to know about one ferret. */
export interface AgendaModeFacts {
  readonly enabled: boolean;
  /** Whether a process is running, so a change waits for its next launch. */
  readonly running: boolean;
}

export interface SessionAgendaModePorts {
  /** `undefined` when there is no such session. */
  facts(sessionId: string): Promise<AgendaModeFacts | undefined>;
  /** Records the switch on the session document AND in its launch environment, stamped with `at`, and brings its summary in line. */
  write(sessionId: string, enabled: boolean, at: string): Promise<void>;
  now(): string;
}

/** A refusal in this domain's own words; the route restates it in HTTP. */
export class SessionAgendaModeError extends Error {
  constructor(
    readonly reason: 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'SessionAgendaModeError';
  }
}

export interface AgendaModeOutcome {
  readonly restartRequired: boolean;
  readonly note: string;
}

/** What a read says: the switch as it is now, and that said in words. */
export interface AgendaModeReading extends AgendaModeOutcome {
  readonly enabled: boolean;
}

/** The answer's sentence, said as what the ferret will be told and when. */
export function agendaModeNote(enabled: boolean, changed: boolean, running: boolean): string {
  const state = enabled ? 'on' : 'off';
  if (!changed) return `Agenda mode was already ${state}.`;
  return running
    ? `Agenda mode is ${state}. This ferret is running, so it takes effect when the ferret restarts.`
    : `Agenda mode is ${state}; this ferret is not running, so it takes effect at its next launch.`;
}

export class SessionAgendaModeService {
  constructor(private readonly ports: SessionAgendaModePorts) {}

  async get(sessionId: string): Promise<AgendaModeReading> {
    const facts = await this.require(sessionId);
    return {
      enabled: facts.enabled,
      restartRequired: false,
      note: `Agenda mode is ${facts.enabled ? 'on' : 'off'}.`,
    };
  }

  async set(sessionId: string, enabled: boolean): Promise<AgendaModeOutcome> {
    const facts = await this.require(sessionId);
    await this.ports.write(sessionId, enabled, this.ports.now());
    const changed = facts.enabled !== enabled;
    return {
      restartRequired: changed && facts.running,
      note: agendaModeNote(enabled, changed, facts.running),
    };
  }

  private async require(sessionId: string): Promise<AgendaModeFacts> {
    const facts = await this.ports.facts(sessionId);
    if (facts === undefined) throw new SessionAgendaModeError('not-found', `no session ${sessionId}`);
    return facts;
  }
}
