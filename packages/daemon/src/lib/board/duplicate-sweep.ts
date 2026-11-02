/**
 * THE SWEEP FOR DUPLICATE ASKS (docs/agenda.md § One ask per thing): reads every open agenda, closes the asks
 * {@link findDuplicates} proves are the same ask twice ("duplicate of !A3"), and keeps what it only suspects for
 * `fy doctor`. Runs at boot and after every Warden sweep; one run at a time, never rejects.
 */
import {
  duplicateNote,
  findDuplicates,
  type AgendaActor,
  type AgendaService,
  type DuplicateAgenda,
  type PossibleDuplicate,
} from '../agenda/index.ts';
import { gateReference, type DuplicateAsk } from '@ferretry/protocol';

const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

export interface DuplicateSweepDependencies {
  readonly agenda: Pick<AgendaService, 'list' | 'resolve'>;
  readonly sessions: { all(): Promise<readonly string[]> };
  readonly homes: { of(sessionId: string): Promise<string> };
  readonly diagnostics: { warn(message: string): void };
}

export class DuplicateSweep {
  private running: Promise<number> | undefined;
  private left: readonly PossibleDuplicate[] = [];

  constructor(private readonly ports: DuplicateSweepDependencies) {}

  /** What the last run suspected but left open, as the health report words it. */
  possible(): readonly DuplicateAsk[] {
    return this.left.map(each => ({ kind: each.kind, members: [...each.members], why: each.why }));
  }

  /** One run, after the one already going; how many asks it closed. */
  async run(): Promise<number> {
    this.running ??= this.sweep()
      .catch((error: unknown) => {
        this.ports.diagnostics.warn(
          `the sweep of duplicate asks failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 0;
      })
      .finally(() => {
        this.running = undefined;
      });
    return await this.running;
  }

  private async sweep(): Promise<number> {
    const agendas: DuplicateAgenda[] = [];
    const answeredGates = new Set<string>();
    let complete = true;
    for (const sessionId of await this.ports.sessions.all()) {
      const listed = await this.ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) {
        complete = false;
        continue;
      }
      for (const item of listed.value.resolved) {
        if (item.resolvedBy !== 'human') continue;
        if (item.gate !== undefined) answeredGates.add(gateReference(item.gate));
        if (item.gateAttached !== undefined) answeredGates.add(gateReference(item.gateAttached));
      }
      agendas.push({
        sessionId,
        home: await this.ports.homes.of(sessionId).catch(() => sessionId),
        items: listed.value.items,
      });
    }
    // A lineage read in part could show a twin as the only one: close nothing then, report what was seen.
    const found = findDuplicates(agendas, { answeredGates, gateReference });
    let closed = 0;
    const stillOpen: PossibleDuplicate[] = [...found.possible];
    if (complete) {
      for (const closure of found.closures) {
        const note = duplicateNote(closure.keep);
        const mutation = await this.ports.agenda
          .resolve(closure.sessionId, closure.id, DAEMON, note)
          .catch(() => undefined);
        if (mutation?.ok === true) closed += 1;
      }
    } else {
      this.ports.diagnostics.warn(
        'an agenda could not be read, so the sweep of duplicate asks closed nothing this time',
      );
      stillOpen.push(
        ...found.closures.map(each => ({
          kind: each.kind,
          members: [each.keep, { sessionId: each.sessionId, id: each.id }],
          why: 'not closed: an agenda could not be read',
        })),
      );
    }
    this.left = stillOpen;
    return closed;
  }
}
