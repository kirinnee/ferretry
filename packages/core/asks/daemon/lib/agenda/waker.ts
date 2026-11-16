import { agendaWakeAt } from '../protocol/agenda.ts';
import type { AgendaLedgerRepository, AgendaService } from './service.ts';
import { agendaSnapshot } from './state-machine.ts';

export const WAKE_SWEEP_MS = 60_000;

/** The reference sweep, scheduled by kernel jobs; persistent boards recover work due while the daemon was down. */
export class AgendaWaker {
  constructor(
    private readonly boards: Pick<AgendaLedgerRepository, 'read'>,
    private readonly agenda: Pick<AgendaService, 'wake'>,
    private readonly sessionIds: () => Promise<readonly string[]>,
    private readonly now: () => string,
  ) {}

  /** Wakes every snoozed item that is due; returns how many woke. Total. */
  async sweep(): Promise<number> {
    const now = Date.parse(this.now());
    let woken = 0;
    for (const sessionId of await this.sessionIds()) {
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
}
