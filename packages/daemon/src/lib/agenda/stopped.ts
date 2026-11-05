import { type AgendaItem, needsYouQueue, type SessionAgendaSummary } from '@ferretry/protocol';

/**
 * The items a ferret is STOPPED ON: its board's Needs-you queue (`needsYouQueue`, docs/agenda.md § The Needs-you
 * queue), the one list every count and push reads — each item once, blockers first. A notice, a resting item and a
 * snoozed one wait on nobody, so none is counted.
 */
export const ownerTurnItems = (items: readonly AgendaItem[]): readonly AgendaItem[] => needsYouQueue(items);

/**
 * Where a session stands in its turn, as far as stopping goes: the instant its CURRENT idle period began
 * (the turn state's own `turnStateAt`) while it is idle, handing control back or waiting on a prompt; absent
 * while it works or when the session keeps no turn state. That instant names the stop, so a ferret that
 * stops once is pushed for once, whatever happens to its board while it sits idle.
 */
export interface SessionStops {
  current(sessionId: string): Promise<string | undefined>;
}

/** Whether a ferret works in AGENDA MODE (a switchable instruction section, off by default). */
export interface AgendaModes {
  enabled(sessionId: string): Promise<boolean>;
}

/**
 * A session's summary with what the chat and the list need besides the count: that its ferret works in agenda
 * mode, and that it is STOPPED — idle, with at least one agenda item on the owner's turn. A session with
 * nothing open has no summary at all, whatever its mode.
 */
export function decoratedSummary(
  summary: SessionAgendaSummary | undefined,
  items: readonly AgendaItem[],
  agendaMode: boolean,
  stop: string | undefined,
): SessionAgendaSummary | undefined {
  if (summary === undefined) return undefined;
  return {
    ...summary,
    ...(agendaMode ? { agendaMode: true as const } : {}),
    ...(stop !== undefined && ownerTurnItems(items).length > 0 ? { stopped: true as const } : {}),
  };
}

/** Tells which turn changes are new: a ferret's idle period is announced when it begins, never twice. */
export class TurnChanges {
  readonly #seen = new Map<string, string>();

  /** Remembers where a session stands without calling it a change: how the daemon learns its fleet at start. */
  prime(sessionId: string, signature: string): void {
    this.#seen.set(sessionId, signature);
  }

  /** Whether the session's turn moved since it was last seen; a session never seen has moved. */
  moved(sessionId: string, signature: string): boolean {
    if (this.#seen.get(sessionId) === signature) return false;
    this.#seen.set(sessionId, signature);
    return true;
  }
}
