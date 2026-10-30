import { agendaInDiscussion } from '@ferretry/protocol';
import type { AgendaLedgerRepository, AgendaService } from './service.ts';
import { agendaSnapshot } from './state-machine.ts';

/** How often the sweep looks for asks that have sat in discussion past the limit. */
export const RESURFACE_SWEEP_MS = 60_000;

/** One timer per key; scheduling a key that is already pending replaces it. */
export interface AgendaSweepTimers {
  schedule(key: string, delayMs: number, task: () => void): void;
  cancel(key: string): void;
}

/**
 * THE TIMER BEHIND `attention.resurfaceAfterMinutes`: an ask that has sat in discussion longer than that
 * is moved onto the owner's queue, with a history note saying the timer did it. A ferret that forgot to
 * `surface` what the owner never answered therefore cannot strand it in a chat nobody is reading. Off
 * unless configured; the sweep only reads each board and surfaces what is overdue, one item at a time, so
 * a board that cannot be read leaves the rest swept.
 */
export class AgendaResurfacer {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly agenda: Pick<AgendaService, 'surface'>,
    private readonly sessionIds: () => readonly string[],
    private readonly timers: AgendaSweepTimers,
    private readonly now: () => string,
    private readonly afterMinutes: number,
    private readonly sweepMs: number = RESURFACE_SWEEP_MS,
  ) {}

  /** Begins sweeping, now and then every `sweepMs`. */
  start(): void {
    void this.tick();
  }

  stop(): void {
    this.timers.cancel('agenda-resurface');
  }

  /** Surfaces every ask in discussion since before the limit; returns how many were moved. Total. */
  async sweep(): Promise<number> {
    const limit = Date.parse(this.now()) - this.afterMinutes * 60_000;
    let moved = 0;
    for (const sessionId of this.sessionIds()) {
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

  private async tick(): Promise<void> {
    await this.sweep().catch(() => 0);
    this.timers.schedule('agenda-resurface', this.sweepMs, () => {
      void this.tick();
    });
  }
}
