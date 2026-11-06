/**
 * WHAT THE APP LEARNS ABOUT A MACHINE'S AGENDA FROM ITS HEALTH — decided here and nowhere else.
 *
 * The app deploys from `main` before a machine updates (`docs/standards/architecture/index.md` § "The app
 * ships before the daemon"), so a few agenda features are offered only where a machine's health lists them.
 * The decision is PER DAEMON, because the app talks to several machines at once and they update separately.
 * It is read from the health the app already reads (`daemon-health.ts`); this module only remembers the
 * answers and spells the paths.
 */

import { DAEMON_FEATURES, type SessionAgendaSummary, type SessionState } from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { type DaemonHealthRead, machineOffers } from './daemon-health.ts';

/**
 * Per-machine memory of what each read machine offers. A failed or unfinished read keeps what an earlier
 * read decided, and only a read that ANSWERED can change it.
 */
export class AgendaWireDirectory {
  /** Whether each read machine raises gate items for cards waiting on the owner (`board.gate-items.1`); absent until its health answered. */
  readonly #gateItems = new Map<DaemonId, boolean>();
  /** Whether each read machine takes the card ask an answer names (`agenda.card-asks.1`); absent until its health answered. */
  readonly #cardAsks = new Map<DaemonId, boolean>();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * Whether the machine raises a gate item for each card waiting on the owner's try (`board.gate-items.1`): the Inbox
   * drops its own to-test row for a card that has one. `undefined` until its health answered, which keeps the rows.
   */
  gateItemsOf(daemonId: DaemonId): boolean | undefined {
    return this.#gateItems.get(daemonId);
  }

  /**
   * Whether the machine takes the card ask an answer names (`agenda.card-asks.1`): `undefined` until its health
   * answered, and `false` for a machine that would refuse the field as malformed.
   */
  cardAsksOf(daemonId: DaemonId): boolean | undefined {
    return this.#cardAsks.get(daemonId);
  }

  note(daemonId: DaemonId, read: DaemonHealthRead): void {
    if (read.kind !== 'read') return;
    const cardAsks = machineOffers(read, DAEMON_FEATURES.agendaCardAsks);
    const cardAsksChanged = this.#cardAsks.get(daemonId) !== cardAsks;
    this.#cardAsks.set(daemonId, cardAsks);
    const gates = machineOffers(read, DAEMON_FEATURES.boardGateItems);
    const gatesChanged = this.#gateItems.get(daemonId) !== gates;
    this.#gateItems.set(daemonId, gates);
    if (gatesChanged || cardAsksChanged) this.#notify();
  }

  clearDaemon(daemonId: DaemonId): void {
    const hadCardAsks = this.#cardAsks.delete(daemonId);
    const hadGates = this.#gateItems.delete(daemonId);
    if (hadGates || hadCardAsks) this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/*
 * One literal per route, spelled out: `scripts/validate/route-agreement.ts` reads client dials
 * lexically, and a path assembled from a variable segment is a path nothing checks against the daemon.
 */

/** `GET`/`POST` the session's board. */
export const sessionAgendaPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/agenda`;

/** `POST` "send now" for the answers the daemon is holding. */
export const sessionAgendaRepliesPath = (sessionId: string): string =>
  `/v1/sessions/${encodeURIComponent(sessionId)}/agenda/replies`;

/** The session's open-items summary. EVERY reader of the summary goes through this. */
export const sessionAgendaSummary = (state: Pick<SessionState, 'agenda'>): SessionAgendaSummary | undefined =>
  state.agenda;
