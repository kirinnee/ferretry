import type {
  AgendaConfirms,
  AgendaGate,
  AgendaId,
  AgendaItem,
  AgendaKind,
  AgendaResponse,
  AgendaSnapshot,
  AgendaSource,
  ResolvedAgendaItem,
  TaskRef,
} from '@ferretry/protocol';
import {
  agendaCardKind,
  clipAtWord,
  formatTaskRef,
  MACHINE_AGENDA_ID,
  MAX_AGENDA_TITLE_LENGTH,
} from '@ferretry/protocol';
import { type AgendaHomeResolver, handsOnRaise, handsOnSource, SELF_AGENDA_HOME } from './home.ts';
import type { MachineAgendaPort } from './machine-agenda.ts';
import {
  isAncestorOf,
  isSubFerret,
  NO_SUB_FERRETS,
  type SubFerretDirectory,
  SUB_FERRET_MAY_ON_AGENDA,
  subFerretRefusal,
} from '../sub-ferret/index.ts';
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
  'login-recipe': 'Suggests a login recipe',
  'phone-approval': 'Approve on your phone',
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

/** Whether a daemon raise is a notice: the kind that may land on the machine agenda. A gate item or a follow-up never is. */
const isNoticeRaise = (request: RaiseAgendaRequest, actor: AgendaActor): boolean =>
  actor.kind === 'daemon' && (request.notice === true || actor.cause === 'warden-escalation');

/** A notice's reference on the machine agenda: the ferret it is about is always part of it, so two ferrets never share a row. */
const machineNoticeRef = (sessionId: string, sourceRef: string | null | undefined, actor: AgendaActor): string => {
  const base = sourceRef ?? `notice:${actor.kind === 'daemon' ? actor.cause : 'agent'}`;
  return base.endsWith(`:${sessionId}`) ? base : `${base}:${sessionId}`;
};

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

/**
 * Whether a card's gate is asking the owner already (docs/agenda.md § One ask per thing): where, as the item and the
 * agenda it is on. A second ask about the same card is refused, or raised without the card.
 */
export interface AgendaGateAsking {
  asking(task: TaskRef): Promise<{ readonly sessionId: string; readonly id: AgendaId } | undefined>;
}

/** A gate whose state could not be read: treated as asking, so a second ask is not let through. */
const UNREADABLE = 'unreadable' as const;

/**
 * An agent's ask that NAMES a card whose gate is asking the owner already is refused: two asks about one card are
 * two things in the owner's Inbox. What it has to say goes on the card.
 */
const refusedForGate = (
  task: TaskRef,
  asking: { readonly sessionId: string; readonly id: AgendaId },
): AgendaMutation => ({
  ok: false,
  error: {
    code: 'invalid',
    message: `${formatTaskRef(task)} is already asking the owner (!${asking.id} on ${asking.sessionId}'s agenda); add what you need to it instead: fy task note ${task.id} "<text>"`,
  },
});

/** No card is known to be asking: every ask keeps the card it names. */
export const NO_AGENDA_GATE_ASKING: AgendaGateAsking = { asking: async () => undefined };

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
    /** Where the daemon asks the owner for a sub-ferret: its lineage's home (docs/agenda.md § Sub-ferret agenda). */
    private readonly homes: AgendaHomeResolver = SELF_AGENDA_HOME,
    /** Which cards are asking the owner through their gate: a second ask about one is not raised (see {@link raise}). */
    private readonly gates: AgendaGateAsking = NO_AGENDA_GATE_ASKING,
    /** Where a notice about a sub-ferret lands when the owner has no home for it: the machine agenda (§ The machine agenda). */
    private readonly machine?: MachineAgendaPort,
  ) {}

  async list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>> {
    if (sessionId === MACHINE_AGENDA_ID && this.machine !== undefined)
      return { ok: true, value: await this.machine.list() };
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

  /**
   * A daemon raise about a sub-ferret that is not a hands-on card lands on the sub-ferret's agenda home instead
   * (docs/agenda.md § Sub-ferret agenda); the mutation's snapshot says where it landed.
   */
  async raise(sessionId: string, request: RaiseAgendaRequest, actor: AgendaActor): Promise<AgendaMutation> {
    const home = await this.redirected(sessionId, handsOnRaise(request, actor), actor, isNoticeRaise(request, actor));
    const titled =
      actor.kind === 'daemon' && request.title === undefined
        ? { ...request, title: DAEMON_TITLES[actor.cause] }
        : request;
    const named =
      home !== sessionId &&
      actor.kind === 'daemon' &&
      (actor.cause === 'warden-escalation' || home === MACHINE_AGENDA_ID)
        ? {
            ...titled,
            title: clipAtWord(
              `${await this.subFerrets.addressOf(sessionId).catch(() => sessionId)}: ${titled.title ?? ''}`,
              MAX_AGENDA_TITLE_LENGTH,
            ),
          }
        : titled;
    if (home === MACHINE_AGENDA_ID && this.machine !== undefined)
      return await this.onMachine(async machine => {
        const { source: _source, sourceRef, task: _task, ...rest } = named;
        return await machine.raiseOrUpdate(machineNoticeRef(sessionId, sourceRef, actor), rest, [sessionId]);
      });
    // The home's focus card is the lead's own work, not the sub-ferret's: a redirected row names no card.
    const focused = named.task === undefined && home === sessionId ? await this.withFocusCard(home, named) : named;
    const asking = await this.gateAsking(focused, actor);
    if (asking !== undefined && asking !== UNREADABLE && named.task !== undefined)
      return refusedForGate(named.task, asking);
    const carded = asking === undefined ? focused : { ...focused, task: undefined };
    const offered = await this.withOfferClose(carded);
    const mutation = await this.apply(home, { action: 'raise', actor, request: offered, at: this.clock.now() });
    if (asking === undefined || focused.task === undefined || !mutation.ok) return mutation;
    const ref = formatTaskRef(focused.task);
    const warning =
      asking === UNREADABLE
        ? `${ref}'s gate could not be read, so this was raised without the card rather than risk a second ask about it; add what the card needs to it instead: fy task note ${focused.task.id} "<text>"`
        : `${ref} is already asking the owner (!${asking.id} on ${asking.sessionId}'s agenda), so this was raised without the card; add what the card needs to it instead: fy task note ${focused.task.id} "<text>"`;
    return { ...mutation, notes: [...(mutation.notes ?? []), warning] };
  }

  /**
   * The gate item or thread through which the card an AGENT's ask would take is already asking, if any. A gate that
   * cannot be read is not "not asking": that would let a second ask through, so it answers {@link UNREADABLE}.
   */
  private async gateAsking(request: RaiseAgendaRequest, actor: AgendaActor) {
    if (actor.kind !== 'agent' || request.task === undefined || request.notice === true) return undefined;
    return await this.gates.asking(request.task).catch(() => UNREADABLE);
  }

  /** The session a daemon act about `sessionId` belongs on: its home when it is a sub-ferret and the act is not hands-on. */
  private async redirected(sessionId: string, handsOn: boolean, actor: AgendaActor, notice: boolean): Promise<string> {
    return actor.kind !== 'daemon' || handsOn ? sessionId : await this.homeOf(sessionId, notice);
  }

  /** Where the daemon's non-hands-on asks about `sessionId` land: its agenda home when it is a sub-ferret, else itself. */
  async homeOf(sessionId: string, notice = false): Promise<string> {
    if (invalidSession(sessionId) !== null) return sessionId;
    if (!(await isSubFerret(this.subFerrets, sessionId))) return sessionId;
    const home = await this.homes.of(sessionId, notice).catch(() => sessionId);
    return home === MACHINE_AGENDA_ID && this.machine === undefined ? sessionId : home;
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
    receipt?: string,
  ): Promise<AgendaMutation> {
    const at = this.clock.now();
    return this.apply(
      sessionId,
      { action: 'answer', actor, id, response, note, at, ...(receipt === undefined ? {} : { receipt }) },
      via,
    );
  }

  /**
   * `now`: the ferret says it is urgent, so an item the owner snoozed wakes too (at most once an hour). `back`: it
   * needs something new from the owner, so an item they replied to returns to their list; without it that item stays parked.
   */
  async edit(
    sessionId: string,
    id: AgendaId,
    patch: EditAgendaPatch,
    actor: AgendaActor,
    now = false,
    back = false,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'edit',
      actor,
      id,
      patch,
      ...(now ? { now } : {}),
      ...(back ? { back } : {}),
      at: this.clock.now(),
    });
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

  /**
   * A card's gate is asked on this thread, or no longer is (`gate: null`; docs/agenda.md § One ask per thing).
   * Daemon-only: the card's lane is the witness.
   */
  async attachGate(
    sessionId: string,
    id: AgendaId,
    gate: AgendaGate | null,
    answered?: AgendaGate,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'attach-gate',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      gate,
      ...(answered === undefined ? {} : { answered }),
      at: this.clock.now(),
    });
  }

  /** An open thread is linked to the card made to carry it out; daemon-only (docs/board.md § Thread cards). */
  async linkTask(sessionId: string, id: AgendaId, task: TaskRef): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'link-task',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      task,
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
    // A row that stands on the board the daemon names is cleared there: only a row that is not there is looked for on the home.
    const here = actor.kind === 'daemon' && (await this.holdsOpenSource(sessionId, source, sourceRef));
    const notice = actor.kind === 'daemon' && actor.cause === 'warden-escalation';
    const home = here ? sessionId : await this.redirected(sessionId, handsOnSource(actor), actor, notice);
    if (home === MACHINE_AGENDA_ID && this.machine !== undefined)
      return await this.onMachine(
        async machine => await machine.resolve(machineNoticeRef(sessionId, sourceRef, actor), note ?? undefined),
      );
    return this.apply(home, {
      action: 'resolve-source',
      actor,
      source,
      sourceRef,
      note,
      at: this.clock.now(),
    });
  }

  /** A write to the machine agenda, answered as a mutation: nothing written reads as unchanged, a failure as a refusal. */
  private async onMachine(
    write: (machine: MachineAgendaPort) => Promise<AgendaMutation | undefined>,
  ): Promise<AgendaMutation> {
    const machine = this.machine as MachineAgendaPort;
    try {
      const written = await write(machine);
      if (written !== undefined) return written;
      const snapshot = await machine.list();
      return {
        ok: true,
        changed: false,
        change: 'unchanged',
        ledger: emptyAgendaLedger(MACHINE_AGENDA_ID, this.clock.now()),
        snapshot,
      };
    } catch (error) {
      return {
        ok: false,
        error: { code: 'corrupt', message: `the machine agenda could not be written: ${String(error)}` },
      };
    }
  }

  private async holdsOpenSource(sessionId: string, source: AgendaSource, sourceRef: string): Promise<boolean> {
    if (invalidSession(sessionId) !== null) return false;
    const ledger = await this.repository.read(sessionId).catch(() => null);
    return (
      ledger?.entries.some(
        entry => entry.lifecycle === 'active' && entry.item.source === source && entry.item.sourceRef === sourceRef,
      ) ?? false
    );
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
      SUB_FERRET_MAY_ON_AGENDA,
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
