/**
 * WHICH SPELLING OF THE AGENDA WIRE A MACHINE SPEAKS — decided here and nowhere else.
 *
 * The app deploys from `main` before a machine updates, so it routinely faces a daemon that only
 * answers the older `attention` spellings (`docs/agenda.md` § Compatibility, `docs/standards/
 * architecture/index.md` § "The app ships before the daemon"). A daemon that lists
 * `DAEMON_FEATURES.agendaWire` in its health answers the `agenda` routes; any other, and one whose
 * health has not been read yet, is spoken to the old way — every daemon answers those for the window.
 *
 * The decision is PER DAEMON, because the app talks to several machines at once and they update
 * separately. It is read from the health the app already reads (`daemon-health.ts`); this module
 * only remembers the answer and spells the paths.
 */

import {
  DAEMON_FEATURES,
  type SessionAgendaSummary,
  type SessionState,
  WARDEN_AGENDA_PATH,
  LEGACY_WARDEN_ATTENTION_PATH,
} from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';
import { type DaemonHealthRead, machineOffers } from './daemon-health.ts';

export type AgendaWire = 'agenda' | 'attention';

/** The spelling a health read selects; anything but a read that lists the feature keeps the older one. */
export const agendaWireOf = (read: DaemonHealthRead): AgendaWire =>
  machineOffers(read, DAEMON_FEATURES.agendaWire) ? 'agenda' : 'attention';

/**
 * Per-machine memory of the spelling. A failed or unfinished read keeps what an earlier read decided:
 * a machine that lists the feature still answers the older routes, so keeping either is safe, and only
 * a read that ANSWERED can change it.
 */
export class AgendaWireDirectory {
  readonly #wires = new Map<DaemonId, AgendaWire>();
  /** Whether each read machine can snooze (`agenda.snooze.1`); absent until its health answered. */
  readonly #snooze = new Map<DaemonId, boolean>();
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** `'attention'` for a machine nobody has read health for yet. */
  wireOf(daemonId: DaemonId): AgendaWire {
    return this.#wires.get(daemonId) ?? 'attention';
  }

  /**
   * Whether the machine can snooze and unsnooze (`agenda.snooze.1`): `false` only when its health ANSWERED
   * without the name — an older daemon refuses the request as an unknown action — and `undefined` until then.
   */
  snoozeOf(daemonId: DaemonId): boolean | undefined {
    return this.#snooze.get(daemonId);
  }

  note(daemonId: DaemonId, read: DaemonHealthRead): void {
    if (read.kind !== 'read') return;
    this.#snooze.set(daemonId, machineOffers(read, DAEMON_FEATURES.agendaSnooze));
    this.#set(daemonId, agendaWireOf(read));
  }

  clearDaemon(daemonId: DaemonId): void {
    this.#snooze.delete(daemonId);
    if (this.#wires.delete(daemonId)) this.#notify();
  }

  #set(daemonId: DaemonId, wire: AgendaWire): void {
    if (this.#wires.get(daemonId) === wire) return;
    this.#wires.set(daemonId, wire);
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}

/*
 * One literal per spelling, spelled out: `scripts/validate/route-agreement.ts` reads client dials
 * lexically, and a path assembled from a variable segment is a path nothing checks against the daemon.
 */

/** `GET`/`POST` the session's board. */
export const sessionAgendaPath = (sessionId: string, wire: AgendaWire): string =>
  wire === 'agenda'
    ? `/v1/sessions/${encodeURIComponent(sessionId)}/agenda`
    : `/v1/sessions/${encodeURIComponent(sessionId)}/attention`;

/** `POST` "send now" for the answers the daemon is holding. */
export const sessionAgendaRepliesPath = (sessionId: string, wire: AgendaWire): string =>
  wire === 'agenda'
    ? `/v1/sessions/${encodeURIComponent(sessionId)}/agenda/replies`
    : `/v1/sessions/${encodeURIComponent(sessionId)}/attention/replies`;

/** `GET` the fleet's "who needs you" view. */
export const wardenAgendaPath = (wire: AgendaWire): string =>
  wire === 'agenda' ? WARDEN_AGENDA_PATH : LEGACY_WARDEN_ATTENTION_PATH;

/**
 * The session's open-items summary: the daemon writes `agenda` beside `attention`, an older daemon only
 * `attention`. EVERY reader of the summary goes through this, so `agenda` wins when both are there.
 */
export const sessionAgendaSummary = (
  state: Pick<SessionState, 'agenda' | 'attention'>,
): SessionAgendaSummary | undefined => state.agenda ?? state.attention;
