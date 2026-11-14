import type {
  AgendaConfirms,
  AgendaId,
  AgendaItem,
  AgendaKind,
  AgendaResponse,
  AgendaSnapshot,
  AgendaSource,
  ResolvedAgendaItem,
} from '../protocol/agenda.ts';
import type { AgendaConversationPage, AgendaVersion, AgendaVersionSummary } from '../protocol/agenda-versions.ts';
import type { TaskRef } from '../protocol/board-refs.ts';
import { agendaCardKind, clipAtWord } from '../protocol/agenda-card.ts';
import { MACHINE_AGENDA_ID, MAX_AGENDA_TITLE_LENGTH } from '../protocol/agenda.ts';
import { MAX_AGENDA_CONVERSATION_FRAGMENT_LENGTH } from '../protocol/agenda-versions.ts';
import { formatTaskRef } from '../protocol/board-refs.ts';
import type { CardAskOperation } from './card-asks.ts';
import { KeyedSerialQueue } from './serial-queue.ts';
import {
  isAncestorOf,
  isSubFerret,
  NO_SUB_FERRETS,
  SUB_FERRET_MAY_ON_AGENDA,
  type SubFerretDirectory,
  subFerretRefusal,
} from '../sub-ferret/index.ts';
import { type AgendaHomeResolver, handsOnRaise, handsOnSource, SELF_AGENDA_HOME } from './home.ts';
import type { MachineAgendaPort } from './machine-agenda.ts';
import { NO_OWNER_CHAT, type OwnerChat } from './owner-chat.ts';
import {
  type AgendaActor,
  type AgendaChange,
  type AgendaFailure,
  type AgendaLedger,
  type AgendaMutation,
  type AgendaNudgeTarget,
  agendaSnapshot,
  agentConfinedTo,
  applyAgendaCommandToSession,
  type DaemonAgendaCause,
  type EditAgendaPatch,
  emptyAgendaLedger,
  type RaiseAgendaRequest,
} from './state-machine.ts';
import {
  type AgendaSeenStore,
  type AgendaVersionStore,
  NO_AGENDA_SEEN,
  NO_AGENDA_VERSIONS,
  versionAuthor,
} from './versions.ts';

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
  /** Durable original changes, delivered outside the ledger transaction queue, including recovered mutations. */
  readonly changeOutbox?: {
    flush(sessionId: string, observer: AgendaChangeObserver): Promise<void>;
    /** The ferrets whose outbox may still hold an event to deliver, so a periodic drain reads only those. */
    pendingFerrets?(): readonly string[];
  };
  /** `by` names who made the change, for the version it is kept as (see {@link AgendaVersionStore}). */
  transact(
    sessionId: string,
    apply: (current: AgendaLedger | null) => AgendaMutation,
    by?: AgendaVersionSummary['by'],
    provenance?: { readonly actor: AgendaActor; readonly via: AgendaVia },
  ): Promise<AgendaMutation>;
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

/** Told after a durable board change. Presentation is best effort; critical delivery rejects until accepted. */
export interface AgendaChangeObserver {
  /** A failure must keep the durable change pending rather than count as an acknowledgement. */
  readonly requiresAcceptance?: true;
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
export const machineNoticeRef = (
  sessionId: string,
  sourceRef: string | null | undefined,
  actor: AgendaActor,
): string => {
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
  rest: 'take agenda items on',
  log: 'log the owner\u2019s words on agenda items',
  merge: 'merge agenda items',
  split: 'split agenda items',
};

export function isAgendaSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

/** Whether a card waits in the lane where released work is tried (Released · to test). */
export interface AgendaCardLanes {
  inToTest(task: TaskRef): Promise<boolean>;
}

/** No card is known to be in the to-test lane: nothing is offered to close by default. */
const NO_AGENDA_CARD_LANES: AgendaCardLanes = { inToTest: async () => false };

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
 * Where to put what an agent wanted to ask about a card whose ask is already open on an agenda (docs/agenda.md § Card
 * asks): that agenda carries the card, so the words go there — by `agenda edit` when it is on the asker's own agenda,
 * else on the card.
 */
const carriedBy = (
  task: TaskRef,
  asking: { readonly sessionId: string; readonly id: AgendaId },
  from: string,
): string =>
  asking.sessionId === from
    ? `${formatTaskRef(task)} already asks the owner on !${asking.id}, which carries the card; put yours on it: fy agenda edit ${asking.id} --where "<each existing point>" --where "<what you need>" (--where replaces them all, so repeat the ones already there)`
    : `${formatTaskRef(task)} already asks the owner on !${asking.id} (${asking.sessionId}'s agenda), which carries the card; add what the card needs to it: fy task note ${task.id} "<text>"`;

/**
 * An agent's ask that NAMES a card whose ask is open already is refused: two asks about one card are two things in the
 * owner's Inbox. It points to the agenda that carries the card.
 */
const refusedForGate = (
  task: TaskRef,
  asking: { readonly sessionId: string; readonly id: AgendaId },
  from: string,
): AgendaMutation => ({ ok: false, error: { code: 'invalid', message: carriedBy(task, asking, from) } });

/** No card is known to be asking: every ask keeps the card it names. */
const NO_AGENDA_GATE_ASKING: AgendaGateAsking = { asking: async () => undefined };

/** The kinds of item whose card the owner is most likely to close with the answer: a to-do or a review. */
const CLOSE_OFFERED_KINDS: ReadonlySet<AgendaKind> = new Set<AgendaKind>(['task', 'review']);

export class AgendaService {
  private readonly mutations = new KeyedSerialQueue();
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
    /** The owner's chat messages, which `fy agenda log` copies verbatim onto an item. */
    private readonly chat: OwnerChat = NO_OWNER_CHAT,
    /** The full versions of every item (`agenda.conversation.1`). */
    private readonly versions: AgendaVersionStore = NO_AGENDA_VERSIONS,
    /** Which version of an item each device last opened. */
    private readonly seen: AgendaSeenStore = NO_AGENDA_SEEN,
  ) {}

  async list(sessionId: string, actor?: AgendaActor): Promise<AgendaQueryResult<AgendaSnapshot>> {
    // The Warden reads a redirected machine home explicitly as the daemon. Session routes never supply this actor.
    if (sessionId === MACHINE_AGENDA_ID && this.machine !== undefined && actor?.kind === 'daemon')
      return { ok: true, value: await this.machine.list() };
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const current = await this.read(sessionId);
    return {
      ok: true,
      value: agendaSnapshot(current ?? emptyAgendaLedger(sessionId, this.clock.now())),
    };
  }

  /** The instant an empty board answers as its `updatedAt`: now. A ferret's board with nothing it may read answers this. */
  emptyBoardAt(): string {
    return this.clock.now();
  }

  async count(sessionId: string): Promise<AgendaQueryResult<number>> {
    const listed = await this.list(sessionId);
    return listed.ok ? { ok: true, value: listed.value.count } : listed;
  }

  /** The first ask for a source obligation, including asks whose closed history has been archived. */
  async raisedObligation(sessionId: string, sourceRef: string): Promise<AgendaId | undefined> {
    const ledger = await this.read(sessionId);
    return ledger?.raisedObligations?.[sourceRef];
  }

  /** Every source obligation a board has raised, `sourceRef -> first ask` (one read of one ledger). */
  async raisedObligations(sessionId: string): Promise<Readonly<Record<string, AgendaId>>> {
    const ledger = await this.read(sessionId);
    return ledger?.raisedObligations ?? {};
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
    if (home === MACHINE_AGENDA_ID && this.machine !== undefined && actor.kind === 'daemon')
      return await this.onMachine(async machine => {
        const { source: _source, sourceRef, task: _task, ...rest } = named;
        return await machine.raiseOrUpdate(machineNoticeRef(sessionId, sourceRef, actor), rest, [sessionId]);
      });
    // On the machine's own board a notice is a row of its own per ferret, never one shared by two ferrets' notices.
    const placed =
      home === MACHINE_AGENDA_ID && home !== sessionId && actor.kind === 'daemon'
        ? { ...named, sourceRef: machineNoticeRef(sessionId, named.sourceRef, actor) }
        : named;
    // The home's focus card is the lead's own work, not the sub-ferret's: a redirected row names no card.
    const focused = placed.task === undefined && home === sessionId ? await this.withFocusCard(home, placed) : placed;
    const asking = await this.gateAsking(focused, actor);
    if (asking !== undefined && asking !== UNREADABLE && placed.task !== undefined)
      return refusedForGate(placed.task, asking, home);
    const carded = asking === undefined ? focused : { ...focused, task: undefined };
    const offered = await this.withOfferClose(carded);
    const mutation = await this.apply(home, { action: 'raise', actor, request: offered, at: this.clock.now() });
    if (asking === undefined || focused.task === undefined || !mutation.ok) return mutation;
    const ref = formatTaskRef(focused.task);
    const warning =
      asking === UNREADABLE
        ? `${ref}'s gate could not be read, so this was raised without the card rather than risk a second ask about it; add what the card needs to it instead: fy task note ${focused.task.id} "<text>"`
        : `this was raised without the card: ${carriedBy(focused.task, asking, home)}`;
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
    return home === MACHINE_AGENDA_ID && !(await this.holdsMachineBoard()) ? sessionId : home;
  }

  /**
   * Whether notices may land on the machine agenda here: a separate machine service answers for it (`machine`), or the
   * session directory knows the machine's own board (the one ledger a daemon notice is then written on, as a row of
   * its own per ferret: {@link machineNoticeRef}).
   */
  private async holdsMachineBoard(): Promise<boolean> {
    return this.machine !== undefined || (await this.sessions.has(MACHINE_AGENDA_ID).catch(() => false));
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
    /** The ask the answer was given to: refused `ask_changed` once the ferret replaced it. */
    askVersion?: number,
  ): Promise<AgendaMutation> {
    const at = this.clock.now();
    return this.apply(
      sessionId,
      {
        action: 'answer',
        actor,
        id,
        response,
        note,
        at,
        ...(receipt === undefined ? {} : { receipt }),
        ...(askVersion === undefined ? {} : { askVersion }),
      },
      via,
    );
  }

  /** Validate under the board's mutation queue, apply in the source, then commit the same answer and receipt. */
  async answerAfter(
    sessionId: string,
    id: AgendaId,
    response: AgendaResponse | undefined,
    actor: AgendaActor,
    note: string | undefined,
    receipt: string,
    askVersion: number | undefined,
    before: () => Promise<void>,
  ): Promise<AgendaMutation> {
    return this.mutations.run(sessionId, async () => {
      const denied = await this.authorize(sessionId, actor);
      if (denied !== null) return { ok: false, error: denied };
      const command = {
        ...(response === undefined ? { action: 'resolve' as const } : { action: 'answer' as const, response }),
        actor,
        id,
        note,
        receipt,
        at: this.clock.now(),
        ...(askVersion === undefined ? {} : { askVersion }),
      };
      const current = await this.read(sessionId);
      const preview = applyAgendaCommandToSession(current, sessionId, command);
      if (!preview.ok || !preview.changed) return preview;
      await before();
      return this.applyNow(sessionId, command);
    });
  }

  /**
   * `now`: the ferret says it is urgent, so an item the owner snoozed wakes too (at most once an hour).
   */
  async edit(
    sessionId: string,
    id: AgendaId,
    patch: EditAgendaPatch,
    actor: AgendaActor,
    now = false,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'edit',
      actor,
      id,
      patch,
      ...(now ? { now } : {}),
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
  async reply(
    sessionId: string,
    id: AgendaId,
    actor: AgendaActor,
    note?: string | null,
    /** The chat message the words are, kept on the conversation so `fy agenda log` does not enter it twice. */
    fromChat?: { readonly messageId: string; readonly at: string },
  ): Promise<AgendaMutation> {
    return this.apply(
      sessionId,
      { action: 'reply', actor, id, note, ...(fromChat === undefined ? {} : { fromChat }), at: this.clock.now() },
      'conversation',
    );
  }

  /**
   * The ferret LOGS the owner's chat words on an item (`fy agenda log`): the daemon copies them verbatim from this
   * session's own messages — the owner's latest, or `messageId` — and they rest the item; then `text` answers them
   * (`reply`: the item returns to the owner's queue, to its old place) or says what the ferret is doing (`rest`).
   * A message that is not the owner's, one that is not this session's and one already logged are refused.
   */
  async log(
    sessionId: string,
    id: AgendaId,
    mode: 'reply' | 'rest',
    text: string,
    actor: AgendaActor,
    messageId?: string,
  ): Promise<AgendaMutation> {
    const unauthorized = await this.authorize(sessionId, actor);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const found = await this.chat.find(sessionId, messageId);
    if (!found.ok) {
      const error: AgendaFailure =
        found.reason === 'not-owner'
          ? {
              code: 'forbidden',
              message: `message ${messageId ?? ''} is not the owner's: only their own words are logged`,
            }
          : {
              code: 'not-found',
              message:
                found.reason === 'none'
                  ? 'the owner has sent this session no message to log'
                  : `no message ${messageId ?? ''} from the owner in this session`,
            };
      return { ok: false, error };
    }
    return this.apply(
      sessionId,
      { action: 'log', actor, id, mode, words: text, chat: found.message, at: this.clock.now() },
      'conversation',
    );
  }

  /** `from` is merged into `id` (`fy agenda merge`): one conversation, every card and link kept, `from` closed. */
  async merge(sessionId: string, id: AgendaId, from: AgendaId, actor: AgendaActor): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'merge', actor, id, from, at: this.clock.now() });
  }

  /** A new item is split off `id` (`fy agenda split`), linked both ways; `moveCards` go along with it. */
  async split(
    sessionId: string,
    id: AgendaId,
    request: RaiseAgendaRequest,
    actor: AgendaActor,
    moveCards?: readonly TaskRef[],
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'split',
      actor,
      id,
      request,
      ...(moveCards === undefined ? {} : { moveCards }),
      at: this.clock.now(),
    });
  }

  /** Full conversation, one bounded text fragment at a time, with the same session authority as item reads. */
  async conversationOf(
    sessionId: string,
    id: AgendaId,
    index = 0,
    offset = 0,
    version?: number,
  ): Promise<AgendaQueryResult<AgendaConversationPage>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    if (
      ![index, offset].every(value => Number.isSafeInteger(value) && value >= 0) ||
      (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
    ) {
      return {
        ok: false,
        error: { code: 'invalid', message: 'conversation index and offset must be nonnegative integers' },
      };
    }
    const ledger = await this.read(sessionId);
    const current = ledger?.entries.find(entry => entry.item.id === id)?.item;
    // Pruned items keep the same read route and wire: their latest complete thread lives in the archive.
    const coldVersion =
      version === undefined && current === undefined
        ? (await this.versions.list(sessionId, id)).at(-1)?.version
        : undefined;
    const selected = version ?? coldVersion;
    const historical = selected === undefined ? undefined : await this.versions.get(sessionId, id, selected);
    if (version !== undefined && historical === undefined) return { ok: false, error: noSuchConversation(version) };
    const item = historical?.item ?? current;
    if (item === undefined) return { ok: false, error: noSuchConversation(version) };
    const full =
      selected === undefined
        ? (ledger?.conversations?.[id] ?? item.conversation ?? [])
        : ((await this.versions.conversation?.(sessionId, id, selected)) ?? historical?.item.conversation ?? []);
    const entry = full[index];
    if (index > full.length || (entry === undefined ? offset !== 0 : offset > entry.text.length)) {
      return { ok: false, error: { code: 'invalid', message: 'conversation cursor is outside the thread' } };
    }
    if (entry === undefined) return { ok: true, value: { total: full.length, index, offset } };
    const text = entry.text.slice(offset, offset + MAX_AGENDA_CONVERSATION_FRAGMENT_LENGTH);
    const end = offset + text.length;
    const next =
      end < entry.text.length
        ? { index, offset: end }
        : index + 1 < full.length
          ? { index: index + 1, offset: 0 }
          : undefined;
    return {
      ok: true,
      value: { total: full.length, index, offset, entry: { ...entry, text }, ...(next === undefined ? {} : { next }) },
    };
  }

  /** Every version kept of an item, oldest first, and the newest this device has opened. */
  async versionsOf(
    sessionId: string,
    id: AgendaId,
    deviceId?: string,
  ): Promise<AgendaQueryResult<{ readonly versions: readonly AgendaVersionSummary[]; readonly seen?: number }>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    await this.read(sessionId);
    const [listed, seen] = await Promise.all([
      this.versions.list(sessionId, id).then(
        versions => ({ versions }),
        (error: unknown) => ({ error }),
      ),
      deviceId === undefined ? undefined : this.seen.seen(sessionId, id, deviceId).catch(() => undefined),
    ]);
    if ('error' in listed) return { ok: false, error: versionsUnavailable(id, listed.error) };
    return { ok: true, value: { versions: listed.versions, ...(seen === undefined ? {} : { seen }) } };
  }

  /** One version of an item in full. */
  async versionOf(sessionId: string, id: AgendaId, version: number): Promise<AgendaQueryResult<AgendaVersion>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    await this.read(sessionId);
    let found: AgendaVersion | undefined;
    try {
      found = await this.versions.get(sessionId, id, version);
    } catch (error) {
      return { ok: false, error: versionsUnavailable(id, error) };
    }
    return found === undefined ? { ok: false, error: noSuchVersion(id, version) } : { ok: true, value: found };
  }

  /** This device opened `id` at `version`. A device that has seen a later one keeps it; the mark that stands is answered. */
  async markSeen(
    sessionId: string,
    id: AgendaId,
    version: number,
    deviceId: string,
  ): Promise<AgendaQueryResult<number>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    await this.read(sessionId);
    let kept: readonly AgendaVersionSummary[];
    try {
      kept = await this.versions.list(sessionId, id);
    } catch (error) {
      return { ok: false, error: versionsUnavailable(id, error) };
    }
    const latest = kept.at(-1)?.version ?? 0;
    if (version > latest) {
      return {
        ok: false,
        error: { code: 'invalid', message: `${id} has no version ${version}: its newest is ${latest}` },
      };
    }
    try {
      return { ok: true, value: await this.seen.mark(sessionId, id, deviceId, version) };
    } catch (error) {
      return { ok: false, error: { code: 'corrupt', message: `the mark could not be kept: ${String(error)}` } };
    }
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

  /** The ferret takes an item on without asking anything yet: it rests as `working`, quiet (docs/agenda.md § States). */
  async rest(sessionId: string, id: AgendaId, why: string, actor: AgendaActor): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'rest', actor, id, why, at: this.clock.now() });
  }

  /** The Warden decided on one nudge message for these resting items: each records its send id first (`rest-nudge.ts`). */
  async nudging(sessionId: string, items: readonly AgendaNudgeTarget[], sendId: string): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'nudging',
      actor: { kind: 'daemon', cause: 'warden-escalation' },
      items,
      sendId,
      at: this.clock.now(),
    });
  }

  /** The Warden nudged the ferret about a resting item: the item records it, if it is still the rest nudged for. */
  async nudged(sessionId: string, target: AgendaNudgeTarget): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'nudged',
      actor: { kind: 'daemon', cause: 'warden-escalation' },
      id: target.id,
      since: target.since,
      nudges: target.nudges,
      at: this.clock.now(),
    });
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
    /** The ask the close was given from: refused `ask_changed` once the ferret replaced it. */
    askVersion?: number,
  ): Promise<AgendaMutation> {
    return this.apply(
      sessionId,
      {
        action: 'resolve',
        actor,
        id,
        note,
        at: this.clock.now(),
        ...(askVersion === undefined ? {} : { askVersion }),
      },
      via,
    );
  }

  async dismiss(
    sessionId: string,
    id: AgendaId,
    actor: AgendaActor,
    note?: string | null,
    /** The ask the close was given from: refused `ask_changed` once the ferret replaced it. */
    askVersion?: number,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'dismiss',
      actor,
      id,
      note,
      at: this.clock.now(),
      ...(askVersion === undefined ? {} : { askVersion }),
    });
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
   * A card ask on this agenda (docs/agenda.md § Card asks): put on it, restated, withdrawn, or the owner's answer
   * recorded (`CardAskOperation`). Daemon-only: the card's lane is the witness.
   */
  async cardAsk(sessionId: string, id: AgendaId, operation: CardAskOperation): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'card-ask',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      operation,
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
    if (home === MACHINE_AGENDA_ID && this.machine !== undefined && actor.kind === 'daemon')
      return await this.onMachine(
        async machine => await machine.resolve(machineNoticeRef(sessionId, sourceRef, actor), note ?? undefined),
      );
    return this.apply(home, {
      action: 'resolve-source',
      actor,
      source,
      sourceRef:
        home === MACHINE_AGENDA_ID && home !== sessionId && actor.kind === 'daemon'
          ? machineNoticeRef(sessionId, sourceRef, actor)
          : sourceRef,
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
    const ledger = await this.read(sessionId).catch(() => null);
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
    return this.mutations.run(sessionId, () => this.applyNow(sessionId, asked, via));
  }

  private async applyNow(
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
    const mutation = await this.repository.transact(
      sessionId,
      current => applyAgendaCommandToSession(current, sessionId, command),
      versionAuthor(command.actor),
      { actor: command.actor, via },
    );
    if (this.repository.changeOutbox !== undefined) {
      await this.flushChanges(sessionId);
    } else if (mutation.ok && mutation.changed && mutation.change !== 'unchanged') {
      await this.notifyChange(sessionId, {
        change: mutation.change,
        actor: command.actor,
        via,
        snapshot: mutation.snapshot,
        ...(mutation.item === undefined ? {} : { item: mutation.item }),
        ...(mutation.addressed === undefined ? {} : { addressed: mutation.addressed }),
      });
    }
    return mutation;
  }

  private async read(sessionId: string): Promise<AgendaLedger | null> {
    const ledger = await this.repository.read(sessionId);
    await this.flushChanges(sessionId);
    return ledger;
  }

  /**
   * Delivers the change events still waiting in an outbox, for the ferrets the outbox says have one: no ledger is
   * listed or read, so with nothing pending a drain does no work. `stopped` ends the drain before the next ferret.
   */
  async flushPending(report: (error: unknown) => void, stopped?: AbortSignal): Promise<void> {
    for (const ferret of this.repository.changeOutbox?.pendingFerrets?.() ?? []) {
      stopped?.throwIfAborted();
      await this.flushChanges(ferret).catch(report);
    }
  }

  private async flushChanges(sessionId: string): Promise<void> {
    await this.repository.changeOutbox?.flush(sessionId, {
      changed: (id, change) => this.notifyChange(id, change),
    });
  }

  private async notifyChange(sessionId: string, change: AgendaBoardChange): Promise<void> {
    if (change.change === 'created' && change.item !== undefined) {
      try {
        await this.observer.raised(sessionId, change.item, change.snapshot);
      } catch {
        // Persistence is primary: presentation can neither revise nor fail the committed mutation.
      }
    }
    try {
      await this.changes.changed(sessionId, change);
    } catch (error) {
      // The board is already committed. Critical delivery must remain pending until its queue accepts it;
      // presentation failures still cannot fail a mutation or hold an otherwise accepted event.
      if (this.repository.changeOutbox !== undefined && this.changes.requiresAcceptance === true) throw error;
    }
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
    // This instance serves sessions and redirects daemon notices through a separate machine service. Only that
    // service owns the reserved ledger; a session id (even one accepted by a directory) cannot alias it.
    if (sessionId === MACHINE_AGENDA_ID && this.machine !== undefined)
      return { code: 'not-found', message: 'the machine agenda is available only at /v1/machine/agenda' };
    const invalid = invalidSession(sessionId);
    if (invalid !== null) return invalid;
    if (actor !== undefined && !agentConfinedTo(actor, sessionId)) {
      return { code: 'forbidden', message: 'an agent may change the agenda only in its own session' };
    }
    return (await this.sessions.has(sessionId)) ? null : { code: 'not-found', message: `no such session ${sessionId}` };
  }
}

const LEAD_VERBS: ReadonlySet<string> = new Set(['edit', 'surface', 'rest', 'resolve', 'dismiss', 'merge', 'split']);

function invalidSession(sessionId: string): AgendaFailure | null {
  return isAgendaSessionId(sessionId)
    ? null
    : { code: 'invalid', message: `not a valid agenda session id: ${sessionId}` };
}

/** A version store that cannot answer is not an item with no versions: say it is unavailable. */
function versionsUnavailable(id: AgendaId, error: unknown): AgendaFailure {
  return { code: 'corrupt', message: `the versions of ${id} could not be read: ${String(error)}` };
}

/**
 * What an item with no such version is answered: the one sentence `versionOf` gives an id that was never raised, and the
 * one a ferret is given for a Warden item it may not read (`routes/ferret-reads.ts`), so the two are the same bytes.
 */
export const noSuchVersion = (id: AgendaId, version: number): AgendaFailure => ({
  code: 'not-found',
  message: `${id} has no version ${version} in this session`,
});

/** What `conversationOf` answers an item (or, with `version`, a version) that is not there; shared like {@link noSuchVersion}. */
export const noSuchConversation = (version: number | undefined): AgendaFailure => ({
  code: 'not-found',
  message: version === undefined ? 'no such agenda item' : 'no such agenda version',
});
