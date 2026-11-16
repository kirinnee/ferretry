import { agendaInDiscussion } from '../protocol/agenda-card.ts';
import type { AgendaLedgerRepository, AgendaService } from './service.ts';
import { agendaSnapshot } from './state-machine.ts';

export const RESURFACE_SWEEP_MS = 60_000;

/** The reference sweep, scheduled by kernel jobs; persistent boards recover work due while the daemon was down. */
export class AgendaResurfacer {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly agenda: Pick<AgendaService, 'surface'>,
    private readonly sessionIds: () => Promise<readonly string[]>,
    private readonly now: () => string,
    private readonly afterMinutes: number,
  ) {}

  /** Surfaces every ask in discussion since before the limit; returns how many were moved. Total. */
  async sweep(): Promise<number> {
    const limit = Date.parse(this.now()) - this.afterMinutes * 60_000;
    let moved = 0;
    for (const sessionId of await this.sessionIds()) {
      const ledger = await this.boards.read(sessionId).catch(() => null);
      if (ledger === null) continue;
      for (const item of agendaSnapshot(ledger).items) {
        // A parked item (snoozed, or replied to) is off the queue on purpose: the timer leaves it where it is.
        if (item.parked !== undefined || !agendaInDiscussion(item)) continue;
        if (item.askedAt === undefined || Date.parse(item.askedAt) > limit) continue;
        const surfaced = await this.agenda
          .surface(
            sessionId,
            item.id,
            { kind: 'daemon', cause: 'system' },
            `No reply in ${this.afterMinutes} minutes: surfaced by the timer.`,
          )
          .catch(() => undefined);
        if (surfaced?.ok === true && surfaced.change === 'surfaced') moved += 1;
      }
    }
    return moved;
  }
}
