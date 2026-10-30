import { agendaWakeAt } from '@ferretry/protocol';
import type { AgendaSweepTimers } from './resurfacer.ts';
import type { AgendaLedgerRepository, AgendaService } from './service.ts';
import { agendaSnapshot } from './state-machine.ts';

/** How often the sweep looks for snoozed items whose time has come. */
export const WAKE_SWEEP_MS = 60_000;

/**
 * THE TIMER BEHIND SNOOZE (docs/agenda.md § Parked items): a snoozed item is woken when its time comes — its
 * `until`, or its `neededBy` when that is sooner (`agendaWakeAt`) — and is back on the owner's queue as a fresh
 * item. Always on; the boards are the only state, so a snooze outlives a daemon restart and an item that fell
 * due while the daemon was down wakes on the first sweep. One item at a time, so a board that cannot be read
 * leaves the rest swept.
 */
export class AgendaWaker {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly agenda: Pick<AgendaService, 'wake'>,
    private readonly sessionIds: () => readonly string[],
    private readonly timers: AgendaSweepTimers,
    private readonly now: () => string,
    private readonly sweepMs: number = WAKE_SWEEP_MS,
  ) {}

  /** Begins sweeping, now and then every `sweepMs`. */
  start(): void {
    void this.tick();
  }

  stop(): void {
    this.timers.cancel('agenda-wake');
  }

  /** Wakes every snoozed item that is due; returns how many woke. Total. */
  async sweep(): Promise<number> {
    const now = Date.parse(this.now());
    let woken = 0;
    for (const sessionId of this.sessionIds()) {
      const ledger = await this.boards.read(sessionId).catch(() => null);
      if (ledger === null) continue;
      for (const item of agendaSnapshot(ledger).items) {
        const due = agendaWakeAt(item);
        if (due === null || Date.parse(due) > now) continue;
        const woke = await this.agenda.wake(sessionId, item.id).catch(() => undefined);
        if (woke?.ok === true && woke.change === 'woke') woken += 1;
      }
    }
    return woken;
  }

  private async tick(): Promise<void> {
    await this.sweep().catch(() => 0);
    this.timers.schedule('agenda-wake', this.sweepMs, () => {
      void this.tick();
    });
  }
}
