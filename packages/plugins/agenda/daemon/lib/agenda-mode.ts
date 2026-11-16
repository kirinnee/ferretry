/**
 * AGENDA MODE, PER FERRET: whether a ferret keeps an agenda of what only the owner can do or decide (docs/agenda.md).
 * `GET` and `PATCH /v1/ferrets/:ferretId/agenda-mode`. ON for a new ferret unless the machine default is off.
 *
 * The switch changes what a ferret is TOLD. A running ferret is never re-instructed — a change of instructions is not
 * worth one of its turns — so the change waits for the next launch and the answer says so.
 */

/** What the switch needs to know about one ferret. */
export interface AgendaModeFacts {
  readonly enabled: boolean;
  /** Whether a process is running, so a change waits for its next launch. */
  readonly running: boolean;
}

export interface AgendaModePorts {
  /** `undefined` when there is no such ferret. */
  facts(ferret: string): Promise<AgendaModeFacts | undefined>;
  /** Records the switch, stamped with `at`. */
  write(ferret: string, enabled: boolean, at: string): Promise<void>;
  now(): string;
}

/** A refusal in this domain's own words; the route restates it in HTTP. */
export class AgendaModeError extends Error {
  constructor(
    readonly reason: 'not-found',
    message: string,
  ) {
    super(message);
    this.name = 'AgendaModeError';
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

export class AgendaModeService {
  constructor(private readonly ports: AgendaModePorts) {}

  async get(ferret: string): Promise<AgendaModeReading> {
    const facts = await this.require(ferret);
    return {
      enabled: facts.enabled,
      restartRequired: false,
      note: `Agenda mode is ${facts.enabled ? 'on' : 'off'}.`,
    };
  }

  async set(ferret: string, enabled: boolean): Promise<AgendaModeOutcome> {
    const facts = await this.require(ferret);
    await this.ports.write(ferret, enabled, this.ports.now());
    const changed = facts.enabled !== enabled;
    return {
      restartRequired: changed && facts.running,
      note: agendaModeNote(enabled, changed, facts.running),
    };
  }

  private async require(ferret: string): Promise<AgendaModeFacts> {
    const facts = await this.ports.facts(ferret);
    if (facts === undefined) throw new AgendaModeError('not-found', `no ferret ${ferret}`);
    return facts;
  }
}

/**
 * THE MACHINE'S DEFAULT FOR AGENDA MODE (docs/agenda.md § The machine default): `agenda.yaml` `agendaMode`, on unless the
 * owner turned it off. It decides only for a ferret that is NEW and recorded no switch of its own, and it is recorded as
 * that ferret's own switch the moment it exists, so a ferret that already exists is never touched by a later change of
 * the default and a stored per-ferret value always wins.
 */
export interface AgendaDefaultPorts {
  /** The machine's switch as saved now; read per start so a saved change applies to the next one. */
  machineDefault(): boolean;
  /** The switch the ferret recorded, or `undefined` when it recorded none. */
  recorded(ferret: string): Promise<boolean | undefined>;
  /** Records agenda mode ON on the ferret. */
  enable(ferret: string): Promise<void>;
}

/**
 * Records agenda mode ON for a new ferret when the machine's default is on, the ferret is an ordinary one and it recorded
 * no value. Returns whether it did. A ferret the daemon runs for itself keeps none, like Pack mode and lessons.
 */
export async function adoptAgendaDefault(
  ports: AgendaDefaultPorts,
  ferret: string,
  eligible: boolean,
): Promise<boolean> {
  if (!eligible) return false;
  if ((await ports.recorded(ferret)) !== undefined) return false;
  if (!ports.machineDefault()) return false;
  await ports.enable(ferret);
  return true;
}
