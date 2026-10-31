import type {
  AgendaConfirms,
  AgendaId,
  AgendaItem,
  AgendaKind,
  AgendaResponse,
  AgendaSnapshot,
  AgendaSource,
  ResolvedAgendaItem,
  TaskRef,
} from '@ferretry/protocol';
import { agendaCardKind } from '@ferretry/protocol';
import { isAncestorOf, NO_SUB_FERRETS, type SubFerretDirectory, subFerretRefusal } from '../sub-ferret/index.ts';
import {
  type AgendaActor,
  type AgendaChange,
  type AgendaFailure,
  type AgendaLedger,
  type AgendaMutation,
  agendaSnapshot,
  agentConfinedTo,
  applyAgendaCommandToSession,
  type DaemonAgendaCause,
  type EditAgendaPatch,
  emptyAgendaLedger,
  type RaiseAgendaRequest,
} from './state-machine.ts';

/** The heading of an item the daemon raised without wording one: plain words, never an id. */
const DAEMON_TITLES: Readonly<Record<DaemonAgendaCause, string>> = {
  'source-reconciliation': 'Needs you',
  'warden-escalation': 'A ferret needs a human',
  system: 'Needs you',
  'harness-prompt': 'The ferret is waiting on you',
  'input-request': 'Needs a secret',
  'secure-copy': 'Asks to approve pastes in advance',
};

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface AgendaClock {
  now(): string;
}

/** The adapter must serialize each callback with every other callback for the same session. */
export interface AgendaLedgerRepository {
  read(sessionId: string): Promise<AgendaLedger | null>;
  transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation>;
}

/**
 * Proof that a board owner exists in this daemon's session registry.
 *
 * A missing agenda ledger is a legitimate empty board only when the session
 * itself is known. Keeping this separate from the ledger repository prevents a
 * typo or forged path from creating a phantom session directory.
 */
export interface AgendaSessionDirectory {
  has(sessionId: string): Promise<boolean>;
}

/** Told only after a newly created item has durably committed. Total: implementations never reject. */
export interface AgendaRaisedObserver {
  raised(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void>;
}

/**
 * Where a mutation came from: the board itself (a route, the CLI, the warden), or a person's chat message
 * that referenced the item — whose own words already reached the ferret, so nothing re-tells it.
 */
export type AgendaVia = 'board' | 'conversation';

/** One committed change to a board, as a change observer is told it. */
export interface AgendaBoardChange {
  readonly change: Exclude<AgendaChange, 'unchanged'>;
  readonly actor: AgendaActor;
  readonly via: AgendaVia;
  readonly snapshot: AgendaSnapshot;
  /** The item, on every change that leaves it open. */
  readonly item?: AgendaItem;
  /** The item as it was closed, on answered, resolved and dismissed changes. */
  readonly addressed?: ResolvedAgendaItem;
}

/** Told after every mutation that changed a board has durably committed. Total: implementations never reject. */
export interface AgendaChangeObserver {
  changed(sessionId: string, change: AgendaBoardChange): Promise<void>;
}

/**
 * The card a session works on (`config.focusTask`, board-design.md §3.3). An agenda add that names no card
 * belongs to the raising session's focus card (§2.6), so an ask is never raised without its work. Total in
 * spirit: a lookup that fails leaves the item without a card rather than refusing it.
 */
export interface AgendaFocusSource {
  focusOf(sessionId: string): Promise<TaskRef | null>;
}

/** No session has a focus card: every item keeps only the card it was raised with. */
export const NO_AGENDA_FOCUS: AgendaFocusSource = { focusOf: async () => null };

export type AgendaQueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgendaFailure };

const SUB_FERRET_DOING: Readonly<Record<string, string>> = {
  raise: 'raise agenda items or notify the owner',
  edit: 'edit agenda items',
  surface: 'surface agenda items',
  resolve: 'close agenda items',
  dismiss: 'dismiss agenda items',
  progress: 'tick agenda items',
};

export function isAgendaSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/** Whether a card waits in the lane where released work is tried (Released · to test). */
export interface AgendaCardLanes {
  inToTest(task: TaskRef): Promise<boolean>;
}

/** No card is known to be in the to-test lane: nothing is offered to close by default. */
export const NO_AGENDA_CARD_LANES: AgendaCardLanes = { inToTest: async () => false };

/** The kinds of item whose card the owner is most likely to close with the answer: a to-do or a review. */
const CLOSE_OFFERED_KINDS: ReadonlySet<AgendaKind> = new Set<AgendaKind>(['task', 'review']);

export class AgendaService {
  constructor(
    private readonly repository: AgendaLedgerRepository,
    private readonly clock: AgendaClock,
    private readonly sessions: AgendaSessionDirectory,
    private readonly observer: AgendaRaisedObserver,
    private readonly changes: AgendaChangeObserver = { changed: async () => undefined },
    private readonly focus: AgendaFocusSource = NO_AGENDA_FOCUS,
    /** Who started whom: a sub-ferret raises and changes nothing here. Absent, every agent is a lead. */
    private readonly subFerrets: SubFerretDirectory = NO_SUB_FERRETS,
    /** Which cards wait in the to-test lane: a to-do or review on one offers to close it by default. */
    private readonly cards: AgendaCardLanes = NO_AGENDA_CARD_LANES,
  ) {}

  async list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const current = await this.repository.read(sessionId);
    return {
      ok: true,
      value: agendaSnapshot(current ?? emptyAgendaLedger(sessionId, this.clock.now())),
    };
  }

  async count(sessionId: string): Promise<AgendaQueryResult<number>> {
    const listed = await this.list(sessionId);
    return listed.ok ? { ok: true, value: listed.value.count } : listed;
  }

  async raise(sessionId: string, request: RaiseAgendaRequest, actor: AgendaActor): Promise<AgendaMutation> {
    const titled =
      actor.kind === 'daemon' && request.title === undefined
        ? { ...request, title: DAEMON_TITLES[actor.cause] }
        : request;
    const carded = titled.task === undefined ? await this.withFocusCard(sessionId, titled) : titled;
    const offered = await this.withOfferClose(carded);
    return this.apply(sessionId, { action: 'raise', actor, request: offered, at: this.clock.now() });
  }

  /** A to-do or review on a card in the to-test lane offers to close it, unless the add already said so. */
  private async withOfferClose(request: RaiseAgendaRequest): Promise<RaiseAgendaRequest> {
    if (request.offerClose !== undefined || request.task === undefined || request.notice === true) return request;
    if (!CLOSE_OFFERED_KINDS.has(agendaCardKind(request))) return request;
    const waiting = await this.cards.inToTest(request.task).catch(() => false);
    return waiting ? { ...request, offerClose: true } : request;
  }

  /** An add that names no card takes the raising session's focus card, when it has one (§2.6). */
  private async withFocusCard(sessionId: string, request: RaiseAgendaRequest): Promise<RaiseAgendaRequest> {
    if (invalidSession(sessionId) !== null) return request;
    const task = await this.focus.focusOf(sessionId).catch(() => null);
    return task === null ? request : { ...request, task };
  }

  async answer(
    sessionId: string,
    id: AgendaId,
    response: AgendaResponse,
    actor: AgendaActor,
    note?: string | null,
    via: AgendaVia = 'board',
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'answer', actor, id, response, note, at: this.clock.now() }, via);
  }

  /** `now`: the ferret says it is urgent, so an item the owner snoozed wakes too (at most once an hour). */
  async edit(
    sessionId: string,
    id: AgendaId,
    patch: EditAgendaPatch,
    actor: AgendaActor,
    now = false,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'edit', actor, id, patch, ...(now ? { now } : {}), at: this.clock.now() });
  }

  /** Tick (or untick) one step of an open item; never resolves it, pushes or tells the ferret. */
  async progress(
    sessionId: string,
    id: AgendaId,
    step: number,
    done: boolean,
    actor: AgendaActor,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'progress', actor, id, step, done, at: this.clock.now() });
  }

  /** The owner asks the raising ferret for more information: the item stays open, waiting on the ferret. */
  async needsInfo(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'needs-info', actor, id, note, at: this.clock.now() });
  }

  /** The owner wants to talk an item through before answering: it stays open, in discussion with the ferret. */
  async discuss(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'discuss', actor, id, note, at: this.clock.now() });
  }

  /** The owner's chat message named this item: it closes as `replied`, their words kept; nobody is pushed. */
  async reply(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'reply', actor, id, note, at: this.clock.now() }, 'conversation');
  }

  /**
   * An item leaves discussion for the owner's queue. The raising ferret, the owner or the daemon's timer may
   * say so; surfacing an item already in the queue is no change.
   */
  async surface(
    sessionId: string,
    id: AgendaId,
    actor: AgendaActor,
    why?: string | null,
    now = false,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'surface', actor, id, why, ...(now ? { now } : {}), at: this.clock.now() });
  }

  /** The owner puts an open item away until a time still ahead (docs/agenda.md § Parked items). */
  async snooze(sessionId: string, id: AgendaId, until: string, actor: AgendaActor): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'snooze', actor, id, until, at: this.clock.now() });
  }

  /** The owner brings a parked item (snoozed, or replied to) back to their queue now. */
  async unsnooze(sessionId: string, id: AgendaId, actor: AgendaActor): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'unsnooze', actor, id, at: this.clock.now() });
  }

  /** The daemon's timer: a snoozed item whose time has come is back on the owner's queue, fresh. */
  async wake(sessionId: string, id: AgendaId): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'wake',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      at: this.clock.now(),
    });
  }

  async resolve(
    sessionId: string,
    id: AgendaId,
    actor: AgendaActor,
    note?: string | null,
    via: AgendaVia = 'board',
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'resolve', actor, id, note, at: this.clock.now() }, via);
  }

  async dismiss(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'dismiss', actor, id, note, at: this.clock.now() });
  }

  /**
   * The owner's action on an item never reached its ferret: the item is the owner's again, as an open card
   * saying so (docs/agenda.md § Delivery). `request` names the request for more information or to discuss
   * it that was not delivered; absent for an answer. Daemon-only: the delivery path is the one witness.
   */
  async undelivered(sessionId: string, id: AgendaId, reason: string, request?: number): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'undelivered',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      reason,
      ...(request === undefined ? {} : { request }),
      at: this.clock.now(),
    });
  }

  /**
   * The held change a confirmation names moved on: the item names the new one, restated, and is the owner's
   * again (docs/agenda.md § Confirming a configuration change). Daemon-only: the config files are the witness.
   */
  async restateConfirms(
    sessionId: string,
    id: AgendaId,
    confirms: AgendaConfirms,
    premise: string,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'restate-confirms',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      confirms,
      premise,
      at: this.clock.now(),
    });
  }

  /** Trusted source reconciliation; transport-facing composition must never expose this directly. */
  async resolveSource(
    sessionId: string,
    source: AgendaSource,
    sourceRef: string,
    actor: AgendaActor,
    note?: string | null,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'resolve-source',
      actor,
      source,
      sourceRef,
      note,
      at: this.clock.now(),
    });
  }

  private async apply(
    sessionId: string,
    asked: Parameters<typeof applyAgendaCommandToSession>[2],
    via: AgendaVia = 'board',
  ): Promise<AgendaMutation> {
    const command = await this.withLineage(sessionId, asked);
    const unauthorized = await this.authorize(sessionId, command.actor);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const limited =
      command.actor.kind === 'agent' && command.actor.overSubFerret === true
        ? null
        : await this.limitSubFerret(command.actor, command.action);
    if (limited !== null) return { ok: false, error: limited };
    const mutation = await this.repository.transact(sessionId, current =>
      applyAgendaCommandToSession(current, sessionId, command),
    );
    if (mutation.ok && mutation.change === 'created' && mutation.item !== undefined) {
      try {
        await this.observer.raised(sessionId, mutation.item, mutation.snapshot);
      } catch {
        // Persistence is primary: presentation can neither revise nor fail the committed mutation.
      }
    }
    if (mutation.ok && mutation.changed && mutation.change !== 'unchanged') {
      try {
        await this.changes.changed(sessionId, {
          change: mutation.change,
          actor: command.actor,
          via,
          snapshot: mutation.snapshot,
          ...(mutation.item === undefined ? {} : { item: mutation.item }),
          ...(mutation.addressed === undefined ? {} : { addressed: mutation.addressed }),
        });
      } catch {
        // The same rule: a projection or a delivery never revises a committed board.
      }
    }
    return mutation;
  }

  /**
   * A lead (or any ancestor) may edit, surface, resolve or dismiss items on the board of a session it started
   * (docs/agenda.md § Sub-ferret agenda). The daemon proves it by lineage and marks the actor; a caller can
   * never set the mark, because the route builds the actor from its credential alone.
   */
  private async withLineage<C extends Parameters<typeof applyAgendaCommandToSession>[2]>(
    sessionId: string,
    command: C,
  ): Promise<C> {
    const { actor } = command;
    if (actor.kind !== 'agent' || actor.sessionId === sessionId || !LEAD_VERBS.has(command.action)) return command;
    if (!(await isAncestorOf(this.subFerrets, actor.sessionId, sessionId))) return command;
    return { ...command, actor: { ...actor, overSubFerret: true } };
  }

  /** Only a lead speaks for the owner's agenda: a sub-ferret that tries is told whom to tell instead. */
  private async limitSubFerret(actor: AgendaActor, action: string): Promise<AgendaFailure | null> {
    if (actor.kind !== 'agent') return null;
    const refusal = await subFerretRefusal(
      this.subFerrets,
      actor.sessionId,
      SUB_FERRET_DOING[action] ?? 'change the agenda',
    );
    return refusal === null ? null : { code: 'forbidden', message: refusal };
  }

  private async authorize(sessionId: string, actor?: AgendaActor): Promise<AgendaFailure | null> {
    const invalid = invalidSession(sessionId);
    if (invalid !== null) return invalid;
    if (actor !== undefined && !agentConfinedTo(actor, sessionId)) {
      return { code: 'forbidden', message: 'an agent may change the agenda only in its own session' };
    }
    return (await this.sessions.has(sessionId)) ? null : { code: 'not-found', message: `no such session ${sessionId}` };
  }
}

const LEAD_VERBS: ReadonlySet<string> = new Set(['edit', 'surface', 'resolve', 'dismiss']);

function invalidSession(sessionId: string): AgendaFailure | null {
  return isAgendaSessionId(sessionId)
    ? null
    : { code: 'invalid', message: `not a valid agenda session id: ${sessionId}` };
}
