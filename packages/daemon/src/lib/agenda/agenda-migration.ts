import type { AgendaLedgerRepository } from './service.ts';
import { agendaSnapshot, emptyAgendaLedger } from './state-machine.ts';

/** Where the migration records that it ran: once, for this daemon's home. */
export interface AgendaMigrationMarker {
  /** Whether the migration has already run. */
  ran(): Promise<boolean>;
  /** Records that it ran, and which ferrets it switched on. */
  record(at: string, switchedOn: readonly string[]): Promise<void>;
}

export interface AgendaMigrationPorts {
  readonly marker: AgendaMigrationMarker;
  readonly boards: Pick<AgendaLedgerRepository, 'read'>;
  readonly modes: {
    enabled(sessionId: string): Promise<boolean>;
    /** Turns agenda mode on for the ferret (its launch environment, and its summary). */
    enable(sessionId: string): Promise<void>;
  };
  readonly now: () => string;
}

export interface AgendaMigrationOutcome {
  readonly ran: boolean;
  readonly switchedOn: readonly string[];
}

/**
 * THE ONE-TIME MIGRATION to agenda mode (docs/notifications.md § Migration): before it, a ferret's open items WERE
 * its agenda, and a ferret that has any must keep working that way. Every session with an open non-notice item
 * gets agenda mode ON; the items themselves are left exactly as they are.
 *
 * IDEMPOTENT AND ONCE: the marker is written when every session was handled, and a start that finds it does nothing — so
 * an owner who later turns a ferret's mode off is never overruled by a restart. A start that finds a session it
 * could not switch writes no marker and the next start tries again; switching a ferret already on is a no-op.
 * Total: it never rejects.
 */
export async function migrateToAgendaMode(
  sessionIds: readonly string[],
  ports: AgendaMigrationPorts,
): Promise<AgendaMigrationOutcome> {
  try {
    if (await ports.marker.ran()) return { ran: false, switchedOn: [] };
    const switchedOn: string[] = [];
    let complete = true;
    for (const sessionId of sessionIds) {
      try {
        const ledger = (await ports.boards.read(sessionId)) ?? emptyAgendaLedger(sessionId, ports.now());
        if (!agendaSnapshot(ledger).items.some(item => item.notice !== true)) continue;
        if (!(await ports.modes.enabled(sessionId))) await ports.modes.enable(sessionId);
        switchedOn.push(sessionId);
      } catch {
        complete = false;
      }
    }
    if (!complete) return { ran: false, switchedOn };
    await ports.marker.record(ports.now(), switchedOn);
    return { ran: true, switchedOn };
  } catch {
    return { ran: false, switchedOn: [] };
  }
}
