import {
  type AgendaId,
  type AgendaItem,
  type AgendaSnapshot,
  agendaBriefOf,
  clipAtWord,
  MAX_AGENDA_TITLE_LENGTH,
} from '@ferretry/protocol';
import type { SubFerretDirectory } from '../sub-ferret/index.ts';
import { parseWardenEscalationSourceRef, wardenEscalationSourceRef } from '../warden/escalation.ts';
import { type AgendaHomeResolver, handsOnItem } from './home.ts';
import type { AgendaQueryResult } from './service.ts';
import type { AgendaActor, AgendaMutation, RaiseAgendaRequest } from './state-machine.ts';

/** Where the migration records that it finished: once, for this daemon's home. */
export interface AgendaHomeMigrationMarker {
  ran(): Promise<boolean>;
  /** Records that it finished, and every item it moved (`<session> !A<n>`). */
  record(at: string, moved: readonly string[]): Promise<void>;
}

export interface AgendaHomeMigrationPorts {
  readonly agenda: {
    list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>>;
    raise(sessionId: string, request: RaiseAgendaRequest, actor: AgendaActor): Promise<AgendaMutation>;
    resolve(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation>;
  };
  readonly sessions: { all(): Promise<readonly string[]> };
  readonly subFerrets: SubFerretDirectory;
  readonly homes: AgendaHomeResolver;
  readonly marker: AgendaHomeMigrationMarker;
  readonly now: () => string;
  readonly diagnostics: { warn(message: string): void };
}

export interface AgendaHomeMigrationOutcome {
  readonly ran: boolean;
  readonly moved: number;
}

const DAEMON: AgendaActor = { kind: 'daemon', cause: 'system' };

/**
 * The reference an item carries on the home: a Warden notification about this ferret names it, because the home
 * holds its siblings' (and its own) of the same class (`escalation.ts`).
 */
const refOnHome = (item: AgendaItem, sessionId: string): string | null => {
  const identity = item.raisedBy === 'daemon' ? parseWardenEscalationSourceRef(item.sourceRef) : undefined;
  return identity?.scope === 'session' && identity.sessionId === undefined
    ? wardenEscalationSourceRef(identity.kind, sessionId)
    : item.sourceRef;
};

/** The refusals no retry will change: the item cannot live on the home, so waiting for the next start is pointless. */
const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(['forbidden', 'invalid', 'too-long']);

const requestOf = (item: AgendaItem, sourceRef: string | null, callsign: string): RaiseAgendaRequest => {
  const title = item.title ?? item.subject;
  return {
    ...agendaBriefOf(item),
    source: item.source,
    sourceRef,
    ...(item.sourceSeq === undefined ? {} : { sourceSeq: item.sourceSeq }),
    subject: item.subject,
    why: item.why,
    ...(item.context === undefined ? {} : { context: item.context }),
    howToResolve: item.howToResolve,
    ...(item.ask === undefined ? {} : { ask: item.ask }),
    ...(item.kind === undefined ? {} : { kind: item.kind }),
    ...(item.answers === undefined ? {} : { answers: item.answers }),
    ...(item.notice === true ? { notice: true as const } : {}),
    ...(item.ping === true ? { ping: true as const } : {}),
    ...(item.task == null ? {} : { task: item.task }),
    ...(item.offerClose === true ? { offerClose: true as const } : {}),
    ...(item.gate === undefined ? {} : { gate: item.gate, title }),
    ...(item.gate === undefined ? { title: clipAtWord(`${callsign}: ${title}`, MAX_AGENDA_TITLE_LENGTH) } : {}),
    carried: item,
  };
};

/** The item already open on the home for the same source, when a raise changed nothing because it was there. */
const standing = async (
  ports: AgendaHomeMigrationPorts,
  home: string,
  item: AgendaItem,
  sourceRef: string | null,
): Promise<AgendaItem | undefined> => {
  if (sourceRef === null) return undefined;
  const listed = await ports.agenda.list(home).catch(() => undefined);
  return listed?.ok === true
    ? listed.value.items.find(each => each.source === item.source && each.sourceRef === sourceRef)
    : undefined;
};

/**
 * THE ONE-TIME MOVE TO AGENDA HOMES (docs/agenda.md § Sub-ferret agenda): every open item the DAEMON raised on a
 * sub-ferret's agenda that is not a hands-on card goes to the agenda home of that sub-ferret, as it stood (its
 * snooze, whose turn it is, its conversation), and is closed where it was, saying where it went. A gate item keeps
 * its reference, so copies of one gate collapse by the one-per-gate rule; any other item gets the sub-ferret's
 * callsign in its title.
 *
 * An item a ferret or the owner raised stays where it is: the daemon may not close it, and a copy raised by the
 * daemon would leave the owner unable to discuss it. The ferret closes its own (`fy tidy`).
 *
 * ONCE: the marker is written only when every agenda was read and every item that can move did; an unfinished pass
 * tries again on the next start. An item the home refuses for good does not hold the marker back. Total: it never
 * rejects.
 */
export async function migrateToAgendaHomes(ports: AgendaHomeMigrationPorts): Promise<AgendaHomeMigrationOutcome> {
  try {
    if (await ports.marker.ran()) return { ran: false, moved: 0 };
    const moved: string[] = [];
    let complete = true;
    for (const sessionId of await ports.sessions.all()) {
      if ((await ports.subFerrets.leadOf(sessionId).catch(() => undefined)) === undefined) continue;
      const listed = await ports.agenda.list(sessionId).catch(() => undefined);
      if (listed === undefined || !listed.ok) {
        complete = false;
        continue;
      }
      const home = await ports.homes.of(sessionId).catch(() => sessionId);
      if (home === sessionId) continue;
      const callsign = await ports.subFerrets.addressOf(sessionId).catch(() => sessionId);
      const homeName = await ports.subFerrets.addressOf(home).catch(() => home);
      for (const item of listed.value.items.filter(each => each.raisedBy === 'daemon' && !handsOnItem(each))) {
        const sourceRef = refOnHome(item, sessionId);
        const raised = await ports.agenda
          .raise(home, requestOf(item, sourceRef, callsign), DAEMON)
          .catch(() => undefined);
        if (raised?.ok === false && PERMANENT_REFUSALS.has(raised.error.code)) {
          ports.diagnostics.warn(
            `!${item.id} on ${sessionId} cannot move to ${home}'s agenda and stays: ${raised.error.message}`,
          );
          continue;
        }
        const landed =
          raised?.ok === true ? (raised.item ?? (await standing(ports, home, item, sourceRef))) : undefined;
        if (landed === undefined) {
          complete = false;
          ports.diagnostics.warn(`!${item.id} on ${sessionId} could not move to ${home}'s agenda`);
          continue;
        }
        const closed = await ports.agenda
          .resolve(sessionId, item.id, DAEMON, `moved to !${landed.id} on ${homeName}'s agenda`)
          .catch(() => undefined);
        if (closed?.ok === true) moved.push(`${sessionId} !${item.id}`);
        else {
          complete = false;
          ports.diagnostics.warn(
            `!${item.id} on ${sessionId} moved to !${landed.id} on ${home}'s agenda but could not be closed where it was`,
          );
        }
      }
    }
    if (!complete) {
      ports.diagnostics.warn(
        `the move to agenda homes is unfinished (${String(moved.length)} moved); the next start tries again`,
      );
      return { ran: false, moved: moved.length };
    }
    await ports.marker.record(ports.now(), moved);
    return { ran: true, moved: moved.length };
  } catch {
    return { ran: false, moved: 0 };
  }
}
