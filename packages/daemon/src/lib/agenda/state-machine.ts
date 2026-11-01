import {
  AGENDA_SCHEMA_VERSION,
  AGENDA_URGENT_WAKE_MS,
  type AgendaAsk,
  type AgendaBrief,
  type AgendaCardAnswer,
  type AgendaClearableField,
  type AgendaConfirms,
  type AgendaCopyPlanRef,
  type AgendaDisposition,
  type AgendaErrorCode,
  type AgendaHistoryEntry,
  type AgendaId,
  type AgendaInputRef,
  type AgendaItem,
  AgendaItemSchema,
  type AgendaKind,
  type AgendaResponse,
  type AgendaRevisableField,
  type AgendaRevision,
  type AgendaSnapshot,
  type AgendaSource,
  type AgendaUndelivered,
  agendaBriefOf,
  agendaBriefRequiredProblems,
  agendaEditShapeProblems,
  agendaNoticeProblems,
  agendaOfferCloseProblems,
  agendaOptionDetailProblems,
  agendaShape,
  agendaShapeProblems,
  agendaWakeAt,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_HISTORY,
  MAX_AGENDA_PER_SESSION,
  MAX_AGENDA_RESOLUTIONS,
  MAX_AGENDA_REVISIONS,
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
  type TaskRef,
} from '@ferretry/protocol';

/** Agent-raised requests are capped separately so automatic sources retain board capacity. */
export const MAX_AGENT_AGENDA_PER_SESSION = 10;

/** Every cause the daemon raises an item for: ONE list, so the type and the ledger's parser cannot disagree. */
export const DAEMON_AGENDA_CAUSES = [
  'source-reconciliation',
  'warden-escalation',
  'system',
  'harness-prompt',
  'input-request',
  'secure-copy',
  'login-recipe',
] as const;
export type DaemonAgendaCause = (typeof DAEMON_AGENDA_CAUSES)[number];
const isDaemonAgendaCause = (value: unknown): value is DaemonAgendaCause =>
  (DAEMON_AGENDA_CAUSES as readonly unknown[]).includes(value);

/**
 * Provenance is a tagged value, not a user-supplied collection of nullable fields. The daemon
 * cause deliberately distinguishes warden escalation from ordinary session Attention.
 */
export type AgendaActor =
  | { readonly kind: 'human' }
  | {
      readonly kind: 'agent';
      readonly sessionId: string;
      readonly name: string | null;
      /**
       * Set only by the agenda service, after it proved by lineage that this session started the session
       * whose board it is changing: the lead may then edit, surface, resolve or dismiss that board's items.
       */
      readonly overSubFerret?: true;
    }
  | { readonly kind: 'daemon'; readonly cause: DaemonAgendaCause };

/** Whether an agent actor is confined to the board or session it is trying to change. */
export function agentConfinedTo(actor: AgendaActor, sessionId: string): boolean {
  return actor.kind !== 'agent' || actor.sessionId === sessionId || actor.overSubFerret === true;
}

export type AgendaEntry =
  | { readonly lifecycle: 'active'; readonly origin: AgendaActor; readonly item: AgendaItem }
  | { readonly lifecycle: 'addressed'; readonly origin: AgendaActor; readonly item: ResolvedAgendaItem };

/** Internal durable state. Active state and count are both derived from the entry lifecycle. */
export interface AgendaLedger {
  readonly sessionId: string;
  readonly nextId: number;
  readonly entries: readonly AgendaEntry[];
  readonly updatedAt: string;
}

/** The card an item is: what it is about, its kind and its answers by direction (all derived when absent). */
export interface AgendaCardFields {
  readonly title?: string;
  readonly kind?: AgendaKind;
  readonly answers?: AgendaCardAnswer[];
}

/** A raise carries the item's card and structured brief (the ask line is the `subject`) alongside its ask. */
export interface RaiseAgendaRequest extends AgendaBrief, AgendaCardFields {
  readonly source: AgendaSource;
  readonly sourceRef: string | null;
  readonly sourceSeq?: number;
  readonly subject: string;
  readonly why: string;
  readonly context?: string | null;
  readonly waitingSince?: string;
  readonly howToResolve: string;
  readonly ask?: AgendaAsk;
  /** A plain notification (`fy notify`): kind info, no ask, never a turn. */
  readonly notice?: true;
  /** The notice asks the phone to buzz; only a notice can. */
  readonly ping?: true;
  /**
   * The held configuration change the owner's answer acts on, resolved by the route from the config files
   * (never taken from the caller): the file, the held edit's digest and its words.
   */
  readonly confirms?: AgendaConfirms;
  /** The board card the item belongs to, kept on the item as sent (`DAEMON_FEATURES.agendaTask`). */
  readonly task?: TaskRef;
  /** The input request an `input` card presents (`AgendaInputRef`); only the daemon raises one. */
  readonly input?: AgendaInputRef;
  /** The paste plan a card presents (`AgendaCopyPlanRef`); only the daemon raises one. */
  readonly copyPlan?: AgendaCopyPlanRef;
  /** The owner's one tap may close `task` too (`DAEMON_FEATURES.agendaOfferClose`); needs a card. */
  readonly offerClose?: true;
}

/** The writing an edit may change: never the ask, the kind, the answers, the reason or who raised the item. */
export interface EditAgendaPatch extends AgendaBrief {
  readonly subject?: string;
  readonly title?: string;
  readonly context?: string | null;
  /** Agenda fields to take off the item (`--not-blocking`, `--clear-will-block`, `--clear-by`). */
  readonly clear?: readonly AgendaClearableField[];
}

export type AgendaCommand =
  | {
      readonly action: 'raise';
      readonly actor: AgendaActor;
      readonly request: RaiseAgendaRequest;
      readonly at: string;
    }
  | {
      readonly action: 'answer';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly response: AgendaResponse;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'resolve';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'dismiss';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'edit';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly patch: EditAgendaPatch;
      /** The ferret says it is urgent: a SNOOZED item wakes (`backFromParked`), at most once an hour. */
      readonly now?: boolean;
      readonly at: string;
    }
  | {
      readonly action: 'progress';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly step: number;
      readonly done: boolean;
      readonly at: string;
    }
  | {
      readonly action: 'needs-info';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'discuss';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      /**
       * The owner's chat message named this open item (`[re !A5 «title»] …`): the item stays open but is PARKED
       * as `replied`, their words kept in its history. Nobody is pushed — the message itself is the delivery. The
       * ferret brings it back (`surface`, `edit`) if the owner still has to decide or do something, or closes it
       * (`done`). Only the owner replies.
       */
      readonly action: 'reply';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      /** An item leaves discussion for the owner's queue; `why` is the one line kept in its history. */
      readonly action: 'surface';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly why?: string | null;
      /** The ferret says it is urgent: a SNOOZED item wakes (`backFromParked`), at most once an hour. */
      readonly now?: boolean;
      readonly at: string;
    }
  | {
      /** The owner puts an open item away `until` a time still ahead (docs/agenda.md § Parked items). */
      readonly action: 'snooze';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly until: string;
      readonly at: string;
    }
  | {
      /** The owner brings a parked item (snoozed, or replied to) back to their queue now. */
      readonly action: 'unsnooze';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly at: string;
    }
  | {
      /** The daemon's timer: a snoozed item whose time (`agendaWakeAt`) has come is back, fresh and unread. */
      readonly action: 'wake';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly at: string;
    }
  | {
      /**
       * The owner's action on an agent-raised item never reached the ferret (docs/agenda.md § Delivery):
       * the item is open again, as a card, with what the owner did kept for a retry. `request` names the
       * request for more information or to discuss it that was not delivered; absent for an answer.
       */
      readonly action: 'undelivered';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly request?: number;
      readonly reason: string;
      readonly at: string;
    }
  | {
      /**
       * The held configuration change an item confirms moved on after it was raised (docs/agenda.md §
       * Confirming a configuration change): the item now names the new one, marked restated, and is the
       * owner's turn again. Daemon-only: the config files are the one witness.
       */
      readonly action: 'restate-confirms';
      readonly actor: AgendaActor;
      readonly id: AgendaId;
      readonly confirms: AgendaConfirms;
      /** The card's premise for the new change: its words, as the raise wrote them. */
      readonly premise: string;
      readonly at: string;
    }
  | {
      readonly action: 'resolve-source';
      readonly actor: AgendaActor;
      readonly source: AgendaSource;
      readonly sourceRef: string;
      readonly note?: string | null;
      readonly at: string;
    };

export interface AgendaFailure {
  readonly code: AgendaErrorCode;
  readonly message: string;
}

export type AgendaChange =
  | 'created'
  | 'refreshed'
  | 'progressed'
  | 'needs-info'
  | 'discussing'
  | 'replied'
  | 'surfaced'
  | 'info-added'
  | 'reopened'
  | 'parked'
  | 'unparked'
  | 'woke'
  | 'answered'
  | 'resolved'
  | 'dismissed'
  | 'unchanged';

export type AgendaMutation =
  | { readonly ok: false; readonly error: AgendaFailure }
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly change: AgendaChange;
      readonly ledger: AgendaLedger;
      readonly snapshot: AgendaSnapshot;
      /** The item on every change that leaves it open; absent for the ones that close it. */
      readonly item?: AgendaItem;
      /** The item as it was closed, on answered, resolved and dismissed mutations; absent otherwise. */
      readonly addressed?: ResolvedAgendaItem;
    };

export function emptyAgendaLedger(sessionId: string, at: string): AgendaLedger {
  return { sessionId, nextId: 1, entries: [], updatedAt: at };
}

export function isActiveAgenda(entry: AgendaEntry): entry is Extract<AgendaEntry, { lifecycle: 'active' }> {
  return entry.lifecycle === 'active';
}

export function isWardenEscalationAgenda(entry: AgendaEntry): boolean {
  return entry.origin.kind === 'daemon' && entry.origin.cause === 'warden-escalation';
}

export function canDismissAgenda(actor: AgendaActor, entry: AgendaEntry): boolean {
  if (actor.kind === 'human') return true;
  if (actor.kind === 'agent') {
    if (actor.overSubFerret === true) return !isWardenEscalationAgenda(entry);
    return entry.origin.kind === 'agent' && entry.origin.sessionId === actor.sessionId;
  }
  return entry.origin.kind === 'daemon';
}

export function agendaSnapshot(ledger: AgendaLedger): AgendaSnapshot {
  const items = ledger.entries
    .filter(isActiveAgenda)
    .map(entry => entry.item)
    .sort(compareActive);
  const resolved = ledger.entries
    .filter((entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> => !isActiveAgenda(entry))
    .map(entry => entry.item)
    .sort(compareAddressed);

  return {
    v: AGENDA_SCHEMA_VERSION,
    sessionId: ledger.sessionId,
    items,
    resolved,
    // EVERY open item, parked ones included: the wire's contract (and every older client's check) is
    // count === items.length. A badge leaves parked items out itself (`agendaBadgeCount`).
    count: items.length,
    parseErrors: 0,
    updatedAt: ledger.updatedAt,
  };
}

export function applyAgendaCommand(current: AgendaLedger, command: AgendaCommand): AgendaMutation {
  return applyToLedger(current, command);
}

/** Apply a command for a known board without making the session id part of every command. */
export function applyAgendaCommandToSession(
  current: AgendaLedger | null,
  sessionId: string,
  command: AgendaCommand,
): AgendaMutation {
  return applyToLedger(current ?? emptyAgendaLedger(sessionId, command.at), command);
}

/**
 * Decodes the internal durable form before an adapter supplies it to the state
 * machine. Keeping this validation in the pure layer prevents corrupt storage
 * from being silently replaced by a fresh board.
 */
export function parseAgendaLedger(value: unknown, sessionId: string): AgendaLedger | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.sessionId !== sessionId ||
    !Number.isSafeInteger(raw.nextId) ||
    (raw.nextId as number) < 1 ||
    typeof raw.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.updatedAt)) ||
    !Array.isArray(raw.entries)
  ) {
    return null;
  }
  const entries: AgendaEntry[] = [];
  const ids = new Set<string>();
  let maxId = 0;
  let active = 0;
  let agentActive = 0;
  let addressed = 0;
  for (const rawEntry of raw.entries) {
    const entry = parseAgendaEntry(rawEntry);
    if (entry === null || ids.has(entry.item.id)) return null;
    ids.add(entry.item.id);
    maxId = Math.max(maxId, idNumber(entry.item.id));
    if (entry.lifecycle === 'active') {
      active += 1;
      if (entry.origin.kind === 'agent') agentActive += 1;
    } else {
      addressed += 1;
    }
    entries.push(entry);
  }
  if (
    (raw.nextId as number) <= maxId ||
    active > MAX_AGENDA_PER_SESSION ||
    agentActive > MAX_AGENT_AGENDA_PER_SESSION ||
    addressed > MAX_AGENDA_RESOLUTIONS
  ) {
    return null;
  }
  return parkOwnerReplies({ sessionId, nextId: raw.nextId as number, entries, updatedAt: raw.updatedAt });
}

/** Whether an open item sits on the ferret's turn only because the owner wrote about it (not asked for more or to discuss). */
function waitsOnOwnerReply(item: AgendaItem): boolean {
  return (
    item.waitingOn === 'ferret' &&
    item.waitingFor === 'discussion' &&
    item.notice !== true &&
    item.askedAt !== undefined &&
    Date.parse(item.askedAt) > Date.parse(item.waitingSince) &&
    !(item.history ?? []).some(entry => entry.kind === 'discuss' && entry.at === item.askedAt)
  );
}

/**
 * THE MIGRATION (docs/agenda.md § Parked items): a reply PARKS an item, so a board an earlier daemon wrote is
 * brought to that shape the moment it is read —
 *
 * - an item left on the ferret's turn after an owner reply (before replies closed items) is parked as
 *   `replied` at the reply;
 * - an item CLOSED as `replied` (while replies closed items) is open again, parked as `replied` at its close —
 *   newest first, and only while the board has room (`MAX_AGENDA_PER_SESSION`, and the agent cap for a
 *   ferret's item). The rest stay closed; the ferret's `surface` or `edit` still brings one back.
 *
 * Pure and idempotent: the next write persists it, and a board with nothing to move is returned as it came.
 */
export function parkOwnerReplies(ledger: AgendaLedger): AgendaLedger {
  const closed = ledger.entries
    .filter(
      (entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> =>
        entry.lifecycle === 'addressed' && entry.item.disposition === 'replied',
    )
    .sort((left, right) => compareAddressed(left.item as ResolvedAgendaItem, right.item as ResolvedAgendaItem));
  const waiting = ledger.entries.some(entry => entry.lifecycle === 'active' && waitsOnOwnerReply(entry.item));
  if (!waiting && closed.length === 0) return ledger;
  const active: AgendaEntry[] = ledger.entries
    .filter(isActiveAgenda)
    .map(entry =>
      entry.item.askedAt !== undefined && waitsOnOwnerReply(entry.item)
        ? { ...entry, item: parkedReply(entry.item, entry.item.askedAt) }
        : entry,
    );
  let agents = active.filter(entry => entry.origin.kind === 'agent').length;
  const reopened: AgendaEntry[] = [];
  for (const entry of closed) {
    const room =
      active.length + reopened.length < MAX_AGENDA_PER_SESSION &&
      (entry.origin.kind !== 'agent' || agents < MAX_AGENT_AGENDA_PER_SESSION);
    const item = room ? reopenedReply(entry.item as ResolvedAgendaItem) : null;
    if (item === null) continue;
    reopened.push({ lifecycle: 'active', origin: entry.origin, item });
    if (entry.origin.kind === 'agent') agents += 1;
  }
  const back = new Set(reopened.map(entry => entry.item.id));
  const addressedLeft = ledger.entries.filter(entry => entry.lifecycle === 'addressed' && !back.has(entry.item.id));
  return { ...ledger, entries: [...active, ...reopened, ...addressedLeft] };
}

/** An open item the owner replied to, parked as `replied` at `at`: out of any wait, with the reply in its history. */
function parkedReply(item: AgendaItem, at: string): AgendaItem {
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, undelivered: _u, ...open } = item;
  return {
    ...open,
    parked: { reason: 'replied', at },
    history: withHistory(open.history, { at, kind: 'replied' }),
  };
}

/** A closed `replied` item open again and parked as `replied` at its close; `null` when it no longer reads as an item. */
function reopenedReply(closed: ResolvedAgendaItem): AgendaItem | null {
  const {
    resolvedAt,
    resolutionNote: _resolutionNote,
    response: _response,
    disposition: _disposition,
    resolvedBy: _resolvedBy,
    resolvedBySession: _resolvedBySession,
    resolvedByName: _resolvedByName,
    ...rest
  } = closed;
  const parsed = AgendaItemSchema.safeParse({ ...rest, parked: { reason: 'replied', at: resolvedAt } });
  return parsed.success ? parsed.data : null;
}

function applyToLedger(ledger: AgendaLedger, command: AgendaCommand): AgendaMutation {
  // The board is part of the authorization decision, not just a storage key.
  // An agent's provenance proves authority only for that exact session. Keep
  // this check in the pure daemon-owned layer so a transport or future
  // in-process caller cannot bypass it by constructing a command directly.
  if (!agentConfinedTo(command.actor, ledger.sessionId)) {
    return failure('forbidden', 'an agent may change the agenda only in its own session');
  }
  switch (command.action) {
    case 'raise':
      return raise(ledger, command);
    case 'answer':
      return addressById(ledger, command, 'answered', 'done', command.response);
    case 'resolve':
      return addressById(ledger, command, 'resolved', 'done');
    case 'dismiss':
      return addressById(ledger, command, 'dismissed', 'dismissed');
    case 'edit':
      return edit(ledger, command);
    case 'progress':
      return progress(ledger, command);
    case 'needs-info':
      return needsInfo(ledger, command);
    case 'discuss':
      return discuss(ledger, command);
    case 'reply':
      return reply(ledger, command);
    case 'surface':
      return surface(ledger, command);
    case 'snooze':
      return snooze(ledger, command);
    case 'unsnooze':
      return unsnooze(ledger, command);
    case 'wake':
      return wake(ledger, command);
    case 'undelivered':
      return undelivered(ledger, command);
    case 'restate-confirms':
      return restateConfirms(ledger, command);
    case 'resolve-source':
      return resolveSource(ledger, command);
  }
}

type RaiseCommand = Extract<AgendaCommand, { action: 'raise' }>;
type AddressCommand = Extract<AgendaCommand, { action: 'answer' | 'resolve' | 'dismiss' }>;
type EditCommand = Extract<AgendaCommand, { action: 'edit' }>;
type ProgressCommand = Extract<AgendaCommand, { action: 'progress' }>;
type NeedsInfoCommand = Extract<AgendaCommand, { action: 'needs-info' }>;
type DiscussCommand = Extract<AgendaCommand, { action: 'discuss' }>;
type ReplyCommand = Extract<AgendaCommand, { action: 'reply' }>;
type SurfaceCommand = Extract<AgendaCommand, { action: 'surface' }>;
type SnoozeCommand = Extract<AgendaCommand, { action: 'snooze' }>;
type UnsnoozeCommand = Extract<AgendaCommand, { action: 'unsnooze' }>;
type WakeCommand = Extract<AgendaCommand, { action: 'wake' }>;
type ResolveSourceCommand = Extract<AgendaCommand, { action: 'resolve-source' }>;
type UndeliveredCommand = Extract<AgendaCommand, { action: 'undelivered' }>;
type RestateConfirmsCommand = Extract<AgendaCommand, { action: 'restate-confirms' }>;

function raise(ledger: AgendaLedger, command: RaiseCommand): AgendaMutation {
  const { actor, request } = command;
  if (request.source !== 'agent-raised' && actor.kind !== 'daemon') {
    return failure('forbidden', `only the daemon may raise an agenda item from source ${request.source}`);
  }
  if (request.sourceRef !== null && actor.kind !== 'daemon') {
    return failure('forbidden', 'stable agenda source references are reserved for trusted daemon producers');
  }
  const noticeProblem = agendaNoticeProblems(request)[0];
  if (noticeProblem !== undefined) return failure('invalid', noticeProblem);
  const offerCloseProblem = agendaOfferCloseProblems(request)[0];
  if (offerCloseProblem !== undefined) return failure('invalid', offerCloseProblem);
  if (request.offerClose === true && request.task === undefined) {
    return failure('invalid', 'there is no card to close: name it with --task F12 (--offer-close needs a card)');
  }
  const optionDetailProblem = agendaOptionDetailProblems(request)[0];
  if (optionDetailProblem !== undefined) return failure('invalid', optionDetailProblem);
  if (request.notice === true && actor.kind === 'human') {
    return failure('forbidden', 'only a ferret or the daemon sends a notice');
  }
  // A ferret's new item carries its premise and context; the daemon's and the Warden's raises write their own.
  const briefProblems = actor.kind === 'agent' ? agendaBriefRequiredProblems(request) : [];
  if (briefProblems.length > 0) return failure('invalid', `a new agenda item needs both: ${briefProblems.join('; ')}`);
  // ONE ANSWER SHAPE PER KIND (docs/agenda.md, "What I need from you"): a ferret's raise that mixes shapes is
  // refused with the shape to write instead. The daemon's own raises carry their own fixed shapes.
  const shapeProblems = actor.kind === 'agent' ? agendaShapeProblems(request) : [];
  if (shapeProblems.length > 0) return failure('invalid', shapeProblems.join('; '));
  if (request.ask === undefined && request.kind !== 'info' && request.notice !== true && actor.kind !== 'daemon') {
    return failure(
      'invalid',
      'human and agent agenda items must declare a structured ask, or be kind info (something to know, no ask)',
    );
  }
  if (request.sourceSeq !== undefined && request.source !== 'agent-raised') {
    return failure('invalid', 'sourceSeq is valid only for agent-raised agenda items');
  }

  const active = ledger.entries.filter(isActiveAgenda);
  const stable =
    request.sourceRef === null
      ? undefined
      : active.find(entry => entry.item.source === request.source && entry.item.sourceRef === request.sourceRef);
  if (stable !== undefined) return refreshStable(ledger, stable, command);

  const duplicate = active.some(
    entry =>
      request.sourceRef === null &&
      entry.item.source === request.source &&
      entry.item.sourceRef === null &&
      sameOrigin(entry.origin, actor) &&
      sameRequest(entry.item, request),
  );
  if (duplicate) return unchanged(ledger);

  if (active.length >= MAX_AGENDA_PER_SESSION) {
    return failure('full', `this session already has ${MAX_AGENDA_PER_SESSION} unresolved items`);
  }
  if (
    actor.kind === 'agent' &&
    active.filter(entry => entry.origin.kind === 'agent').length >= MAX_AGENT_AGENDA_PER_SESSION
  ) {
    return failure('full', `this session already has ${MAX_AGENT_AGENDA_PER_SESSION} unresolved agent requests`);
  }
  if (!Number.isSafeInteger(ledger.nextId) || ledger.nextId < 1 || ledger.nextId >= Number.MAX_SAFE_INTEGER) {
    return failure('full', 'this session has exhausted its agenda id sequence');
  }

  const item = withRaisedBy(
    {
      id: `A${ledger.nextId}` as AgendaId,
      source: request.source,
      sourceRef: request.sourceRef,
      ...(request.sourceSeq === undefined ? {} : { sourceSeq: request.sourceSeq }),
      subject: request.subject,
      why: request.why,
      ...(request.context === undefined ? {} : { context: request.context }),
      waitingSince: actor.kind === 'daemon' && request.waitingSince !== undefined ? request.waitingSince : command.at,
      howToResolve: request.howToResolve,
      ...(request.ask === undefined ? {} : { ask: request.ask }),
      ...cardFieldsOf(request),
      ...agendaBriefOf(request),
      // A new ask is the OWNER's turn: no `waitingOn`. The ferret's turn begins only when the owner replies.
      ...(request.notice === true ? { notice: true as const } : {}),
      ...(request.ping === true ? { ping: true as const } : {}),
      ...(request.confirms === undefined ? {} : { confirms: request.confirms }),
      ...(request.task === undefined ? {} : { task: request.task }),
      ...(request.input === undefined ? {} : { input: request.input }),
      ...(request.copyPlan === undefined ? {} : { copyPlan: request.copyPlan }),
      ...(request.offerClose === true ? { offerClose: true as const } : {}),
    },
    actor,
  );
  const next: AgendaLedger = {
    ...ledger,
    nextId: ledger.nextId + 1,
    entries: [...ledger.entries, { lifecycle: 'active', origin: actor, item }],
    updatedAt: command.at,
  };
  return success(next, true, 'created', item);
}

function refreshStable(
  ledger: AgendaLedger,
  existing: Extract<AgendaEntry, { lifecycle: 'active' }>,
  command: RaiseCommand,
): AgendaMutation {
  const request = command.request;
  if (
    existing.item.sourceSeq !== undefined &&
    (request.sourceSeq === undefined || request.sourceSeq < existing.item.sourceSeq)
  ) {
    return unchanged(ledger);
  }
  if (sameRequest(existing.item, request) && existing.item.sourceSeq === request.sourceSeq) {
    return unchanged(ledger);
  }

  const item: AgendaItem = {
    ...existing.item,
    subject: request.subject,
    why: request.why,
    context: request.context ?? null,
    howToResolve: request.howToResolve,
    ...(request.ask === undefined ? { ask: undefined } : { ask: request.ask }),
    ...(request.sourceSeq === undefined ? { sourceSeq: undefined } : { sourceSeq: request.sourceSeq }),
    // The card is part of what a refresh restates: a title, kind or answers left out are cleared too.
    title: request.title,
    kind: request.kind,
    answers: request.answers,
    // A refresh replaces the brief whole: a field the new request leaves out is cleared, not kept.
    premise: request.premise,
    decided: request.decided,
    stillOpen: request.stillOpen,
    terms: request.terms,
    questions: request.questions,
    recommendation: request.recommendation,
    optionDetails: request.optionDetails,
    impact: request.impact,
    urgency: request.urgency,
    blockingNow: request.blockingNow,
    willBlock: request.willBlock,
    neededBy: request.neededBy,
    notice: request.notice,
    ping: request.ping,
    links: request.links,
    steps: request.steps,
    body: request.body,
    questionAnswer: request.questionAnswer,
    // Ticks belong to the steps they were made on: the same steps keep them, new steps start clean.
    stepsDone: sameSteps(existing.item.steps, request.steps) ? existing.item.stepsDone : undefined,
  };
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === existing.item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'refreshed', item);
}

function addressById(
  ledger: AgendaLedger,
  command: AddressCommand,
  change: Extract<AgendaChange, 'answered' | 'resolved' | 'dismissed'>,
  disposition: 'done' | 'dismissed',
  response?: AgendaResponse,
): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  if (command.action === 'dismiss') {
    if (!canDismissAgenda(command.actor, target)) {
      return failure('forbidden', 'an agent or daemon may dismiss only an agenda item it raised');
    }
  } else if (!canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may resolve only an agenda item it raised');
  }
  if (command.action === 'resolve' && command.actor.kind === 'agent' && isQuestionShape(target.item)) {
    if ((command.note ?? '').trim() === '') {
      return failure(
        'invalid',
        `${command.id} is a question the owner has not answered: closing it withdraws the question, so say why with --reason (the owner sees "withdrawn"); to answer the owner's own question, \`edit ${command.id} --question-answer\` instead and keep the options`,
      );
    }
  }
  if (command.action === 'answer') {
    // The input form answers an input card, because the value never travels as an agenda answer.
    if (target.item.kind === 'input') {
      return failure('use_input_form', `${command.id} is answered in its input form, not as an agenda answer`);
    }
    // A paste plan is answered by the owner's plan route, which makes its rules: an agenda answer would make none.
    if (target.item.copyPlan !== undefined) {
      return failure(
        'use_input_form',
        `${command.id} is a paste plan: answer it on its card, or with fy copy plan approve`,
      );
    }
    // An answer to a confirmation is the owner's decision about a configuration change: never a ferret's.
    if (target.item.confirms !== undefined && command.actor.kind !== 'human') {
      return failure(
        'forbidden',
        `only the owner answers ${command.id}: it decides a change to ${target.item.confirms.path}; close it with dismiss instead`,
      );
    }
    if (!responseMatchesAsk(target.item.ask, command.response)) {
      const message =
        target.item.ask === undefined
          ? `${command.id} has no structured ask`
          : `${command.id} asks for a ${target.item.ask.kind} response`;
      return failure('invalid', message);
    }
  }
  // A structured ask may still be RESOLVED without its response: the owner can reply in words instead
  // of picking (the note carries them to the ferret), and the raising ferret closes its own item once
  // the matter settled some other way. An answer, when given, must still match the ask.
  //
  // THE EXCEPTION IS AN INPUT CARD: the owner's field next to it may hold a password, and the app sends
  // whatever is in the composer with Resolve or Dismiss. Only the daemon's own status words are kept.
  const note = target.item.kind === 'input' && command.actor.kind !== 'daemon' ? null : (command.note ?? null);
  return addressed(ledger, target, command.actor, note, command.at, disposition, change, response);
}

function isQuestionShape(item: AgendaItem): boolean {
  const shape = agendaShape(item);
  return shape !== 'info' && shape !== 'input';
}

function resolveSource(ledger: AgendaLedger, command: ResolveSourceCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') {
    return failure('forbidden', 'only the daemon may reconcile a trusted agenda source');
  }
  const target = ledger.entries
    .filter(isActiveAgenda)
    .find(entry => entry.item.source === command.source && entry.item.sourceRef === command.sourceRef);
  return target === undefined
    ? unchanged(ledger)
    : addressed(ledger, target, command.actor, command.note ?? null, command.at, 'done', 'resolved');
}

function parseAgendaEntry(value: unknown): AgendaEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const origin = parseAgendaActor(raw.origin);
  if (origin === null) return null;
  if (raw.lifecycle === 'active') {
    const item = AgendaItemSchema.safeParse(raw.item);
    return item.success && sameItemOrigin(item.data, origin) ? { lifecycle: 'active', origin, item: item.data } : null;
  }
  if (raw.lifecycle === 'addressed') {
    const item = ResolvedAgendaItemSchema.safeParse(raw.item);
    return item.success && sameItemOrigin(item.data, origin)
      ? { lifecycle: 'addressed', origin, item: item.data }
      : null;
  }
  return null;
}

function parseAgendaActor(value: unknown): AgendaActor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'human') return { kind: 'human' };
  if (
    raw.kind === 'agent' &&
    typeof raw.sessionId === 'string' &&
    (typeof raw.name === 'string' || raw.name === null)
  ) {
    return { kind: 'agent', sessionId: raw.sessionId, name: raw.name };
  }
  if (raw.kind === 'daemon' && isDaemonAgendaCause(raw.cause)) return { kind: 'daemon', cause: raw.cause };
  return null;
}

function sameItemOrigin(item: AgendaItem | ResolvedAgendaItem, origin: AgendaActor): boolean {
  return (
    item.raisedBy === origin.kind &&
    item.raisedBySession === (origin.kind === 'agent' ? origin.sessionId : null) &&
    item.raisedByName === (origin.kind === 'agent' ? origin.name : null)
  );
}

function addressed(
  ledger: AgendaLedger,
  target: Extract<AgendaEntry, { lifecycle: 'active' }>,
  actor: AgendaActor,
  note: string | null,
  at: string,
  disposition: AgendaDisposition,
  change: Extract<AgendaChange, 'answered' | 'resolved' | 'dismissed' | 'replied'>,
  response?: AgendaResponse,
  entry?: AgendaHistoryEntry,
): AgendaMutation {
  const {
    waitingOn: _waitingOn,
    askedAt: _askedAt,
    waitingFor: _waitingFor,
    undelivered: _undelivered,
    ...open
  } = target.item;
  const item = withResolvedBy(
    {
      ...open,
      ...(entry === undefined ? {} : { history: withHistory(open.history, entry) }),
      resolvedAt: at,
      resolutionNote: note,
      disposition,
      ...(response === undefined ? {} : { response }),
    },
    actor,
  );
  const active = ledger.entries.filter(
    (entry): entry is Extract<AgendaEntry, { lifecycle: 'active' }> =>
      entry.lifecycle === 'active' && entry.item.id !== target.item.id,
  );
  const history = [
    { lifecycle: 'addressed' as const, origin: target.origin, item },
    ...ledger.entries.filter(
      (entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> => entry.lifecycle === 'addressed',
    ),
  ].slice(0, MAX_AGENDA_RESOLUTIONS);
  const next: AgendaLedger = { ...ledger, entries: [...active, ...history], updatedAt: at };
  return success(next, true, change, undefined, item);
}

function canAddressAgenda(actor: AgendaActor, entry: AgendaEntry): boolean {
  return canDismissAgenda(actor, entry);
}

function responseMatchesAsk(ask: AgendaAsk | undefined, response: AgendaResponse): boolean {
  if (ask === undefined) return false;
  // The owner's own words instead of the options: any ask that offers options takes them.
  if (response.kind === 'other') return ask.kind !== 'open-question' && ask.kind !== 'task';
  if (ask.kind !== response.kind) return false;
  if (ask.kind !== 'multiple-choice' || response.kind !== 'multiple-choice') return true;
  return ask.options.some(option => option.label === response.choice);
}

function sameRequest(item: AgendaItem, request: RaiseAgendaRequest): boolean {
  return (
    item.subject === request.subject &&
    item.why === request.why &&
    (item.context ?? null) === (request.context ?? null) &&
    item.howToResolve === request.howToResolve &&
    JSON.stringify(item.ask ?? null) === JSON.stringify(request.ask ?? null) &&
    item.notice === request.notice &&
    item.ping === request.ping &&
    JSON.stringify(cardFieldsOf(item)) === JSON.stringify(cardFieldsOf(request)) &&
    JSON.stringify(agendaBriefOf(item)) === JSON.stringify(agendaBriefOf(request))
  );
}

/** Just the card fields a request or item carries, in one fixed key order, the absent ones left out. */
function cardFieldsOf(value: AgendaCardFields): AgendaCardFields {
  return {
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.answers === undefined ? {} : { answers: value.answers }),
  };
}

function sameOrigin(left: AgendaActor, right: AgendaActor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'human' && right.kind === 'human') return true;
  if (left.kind === 'agent' && right.kind === 'agent') return left.sessionId === right.sessionId;
  return left.kind === 'daemon' && right.kind === 'daemon' && left.cause === right.cause;
}

function withRaisedBy(
  item: Omit<AgendaItem, 'raisedBy' | 'raisedBySession' | 'raisedByName'>,
  actor: AgendaActor,
): AgendaItem {
  switch (actor.kind) {
    case 'human':
      return { ...item, raisedBy: 'human', raisedBySession: null, raisedByName: null };
    case 'agent':
      return { ...item, raisedBy: 'agent', raisedBySession: actor.sessionId, raisedByName: actor.name };
    case 'daemon':
      return { ...item, raisedBy: 'daemon', raisedBySession: null, raisedByName: null };
  }
}

function withResolvedBy(
  item: Omit<ResolvedAgendaItem, 'resolvedBy' | 'resolvedBySession' | 'resolvedByName'>,
  actor: AgendaActor,
): ResolvedAgendaItem {
  switch (actor.kind) {
    case 'human':
      return { ...item, resolvedBy: 'human', resolvedBySession: null, resolvedByName: null } as ResolvedAgendaItem;
    case 'agent':
      return {
        ...item,
        resolvedBy: 'agent',
        resolvedBySession: actor.sessionId,
        resolvedByName: actor.name,
      } as ResolvedAgendaItem;
    case 'daemon':
      return { ...item, resolvedBy: 'daemon', resolvedBySession: null, resolvedByName: null } as ResolvedAgendaItem;
  }
}

function idNumber(id: AgendaId): number {
  return Number(id.slice(1));
}

function compareActive(left: AgendaItem, right: AgendaItem): number {
  return left.waitingSince.localeCompare(right.waitingSince) || idNumber(left.id) - idNumber(right.id);
}

function compareAddressed(left: ResolvedAgendaItem, right: ResolvedAgendaItem): number {
  return right.resolvedAt.localeCompare(left.resolvedAt) || idNumber(left.id) - idNumber(right.id);
}

function unchanged(ledger: AgendaLedger): AgendaMutation {
  return success(ledger, false, 'unchanged');
}

function success(
  ledger: AgendaLedger,
  changed: boolean,
  change: AgendaChange,
  item?: AgendaItem,
  addressed?: ResolvedAgendaItem,
): AgendaMutation {
  return {
    ok: true,
    changed,
    change,
    ledger,
    snapshot: agendaSnapshot(ledger),
    ...(item === undefined ? {} : { item }),
    ...(addressed === undefined ? {} : { addressed }),
  };
}

function failure(code: AgendaErrorCode, message: string): AgendaMutation {
  return { ok: false, error: { code, message } };
}

const EDITABLE_FIELDS = [
  'subject',
  'title',
  'context',
  'premise',
  'decided',
  'stillOpen',
  'terms',
  'questions',
  'recommendation',
  'optionDetails',
  'impact',
  'urgency',
  'blockingNow',
  'willBlock',
  'neededBy',
  'links',
  'steps',
  'body',
  'questionAnswer',
] as const satisfies readonly AgendaRevisableField[];

/** The option labels of each question, in order — what an edit must leave alone to keep the ask true. */
function questionShape(questions: AgendaBrief['questions']): string {
  return JSON.stringify(
    (questions ?? []).map(question => question.options?.map(option => option.label.trim()) ?? null),
  );
}

/** Whether a patch value says what the item already says; an absent context and a null one are the same. */
function sameField(left: unknown, right: unknown): boolean {
  return sortedJson(left ?? null) === sortedJson(right ?? null);
}

/**
 * Rewords an OPEN item in place. The writing changes (summary, context, premise, what is decided and still
 * open, terms, question wording, recommendation, impact, urgency, links); the ask, the reason and the raiser
 * do not, and neither does the item's place in line, so an edit never re-notifies. Only whoever may close an
 * item may edit it. Questions keep their count and their options, because the ask was derived from them.
 *
 * Every edit that changes something appends ONE revision (who, which fields, what they said before) so the
 * card can be read as a living summary of its discussion; an edit that changes nothing adds none. An edit of
 * an item on the FERRET's turn by the ferret hands it back to the owner (`surface` does the same without words); it pings nobody.
 */
function edit(ledger: AgendaLedger, command: EditCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    // An edit of an item the owner replied to is the ferret asking again, in new words: it reopens, then edits.
    const reopened = reopenReplied(
      ledger,
      command.id,
      command.actor,
      command.at,
      { at: command.at, kind: 'updated' },
      command.patch,
    );
    if (reopened === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
    if (!reopened.ok) return reopened;
    const edited = edit(reopened.ledger, command);
    return !edited.ok || edited.change === 'unchanged' ? (edited.ok ? reopened : edited) : edited;
  }
  if (!canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may edit only an agenda item it raised');
  }
  if (target.item.parked?.reason === 'replied') {
    const stale = repliedRefreshProblem(command.actor, command.id, command.patch);
    if (stale !== null) return failure('invalid', stale);
  }
  const back = backFromParked(target.item, command.actor, command.at, command.now === true);
  if ('code' in back) return failure(back.code, back.message);
  if (back !== target.item) {
    // The ferret's edit brings a parked item back first (fresh and unread), then edits it as it stands.
    const unparked = replaceItem(ledger, back, command.at, 'unparked');
    if (!unparked.ok) return unparked;
    const edited = edit(unparked.ledger, { ...command, now: false });
    return !edited.ok || edited.change === 'unchanged' ? (edited.ok ? unparked : edited) : edited;
  }
  const patch = command.patch;
  const clears = (patch.clear ?? []).filter(field => target.item[field] !== undefined);
  if (EDITABLE_FIELDS.every(field => patch[field] === undefined) && (patch.clear ?? []).length === 0) {
    return failure('invalid', `nothing to edit: give at least one of ${EDITABLE_FIELDS.join(', ')}`);
  }
  if (patch.questions !== undefined && questionShape(patch.questions) !== questionShape(target.item.questions)) {
    return failure('invalid', 'questions may be reworded but not added, removed or given other options');
  }
  const optionDetailProblem = agendaOptionDetailProblems({
    ...target.item,
    ...(patch.optionDetails === undefined ? {} : { optionDetails: patch.optionDetails }),
  })[0];
  if (optionDetailProblem !== undefined) return failure('invalid', optionDetailProblem);
  // Steps belong to a to-do alone: an edit never gives them to a card of another shape.
  const shapeProblem = command.actor.kind === 'agent' ? agendaEditShapeProblems(target.item, patch)[0] : undefined;
  if (shapeProblem !== undefined) return failure('invalid', shapeProblem);
  const changed = EDITABLE_FIELDS.filter(
    field =>
      clears.some(cleared => cleared === field) ||
      (patch[field] !== undefined && !sameField(patch[field], target.item[field])),
  );
  // The ferret's edit answers its turn: the item goes back to the owner, whether or not the words changed.
  const handsBack = target.item.waitingOn !== undefined && command.actor.kind === 'agent';
  if (changed.length === 0 && !handsBack) return unchanged(ledger);
  const { stepsDone, waitingOn: _waitingOn, askedAt: _askedAt, waitingFor: _waitingFor, ...kept } = target.item;
  const revision: AgendaRevision = {
    at: command.at,
    by: command.actor.kind,
    changed,
    previous: Object.fromEntries(
      changed.flatMap(field => (target.item[field] === undefined ? [] : [[field, target.item[field]]])),
    ),
  };
  const edited: AgendaItem = {
    ...kept,
    ...(!handsBack && target.item.waitingOn !== undefined
      ? {
          waitingOn: target.item.waitingOn,
          ...(target.item.askedAt === undefined ? {} : { askedAt: target.item.askedAt }),
          ...(target.item.waitingFor === undefined ? {} : { waitingFor: target.item.waitingFor }),
        }
      : {}),
    ...(stepsDone === undefined || changed.includes('steps') ? {} : { stepsDone }),
    ...Object.fromEntries(
      changed.map(field => [field, clears.some(cleared => cleared === field) ? undefined : patch[field]]),
    ),
    ...(changed.length === 0
      ? {}
      : { revisions: [...(target.item.revisions ?? []), revision].slice(-MAX_AGENDA_REVISIONS) }),
  };
  const final: AgendaItem = handsBack
    ? { ...edited, history: withHistory(edited.history, { at: command.at, kind: 'updated' }) }
    : edited;
  // Only an answer to a request for MORE INFORMATION is `info-added`; a discussion handed back is a plain refresh.
  const change = handsBack && target.item.waitingFor !== 'discussion' ? 'info-added' : 'refreshed';
  return replaceItem(ledger, final, command.at, change);
}

function replaceItem(
  ledger: AgendaLedger,
  item: AgendaItem,
  at: string,
  change: Extract<
    AgendaChange,
    | 'refreshed'
    | 'needs-info'
    | 'discussing'
    | 'surfaced'
    | 'info-added'
    | 'reopened'
    | 'replied'
    | 'parked'
    | 'unparked'
    | 'woke'
  >,
): AgendaMutation {
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === item.id ? { ...entry, item } : entry,
    ),
    updatedAt: at,
  };
  return success(next, true, change, item);
}

/** JSON with keys in sorted order, so two items compare by content and not by how their keys were spread. */
function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, each: unknown) =>
    each !== null && typeof each === 'object' && !Array.isArray(each)
      ? Object.fromEntries(Object.entries(each).sort(([left], [right]) => left.localeCompare(right)))
      : each,
  );
}

/** The history with one more entry, the oldest dropped past the bound. */
function withHistory(
  history: readonly AgendaHistoryEntry[] | undefined,
  entry: AgendaHistoryEntry,
): AgendaHistoryEntry[] {
  return [...(history ?? []), entry].slice(-MAX_AGENDA_HISTORY);
}

/**
 * The owner asks the raising ferret for more information. The item stays OPEN, marked waiting on the
 * ferret, and each request is counted (`infoRequests`) so the delivery and the push after it are exactly
 * once per request. Only the owner asks, and only of an item a ferret raised: nobody else can be asked.
 * Asking again while the ferret has not yet answered is the same request.
 */
function needsInfo(ledger: AgendaLedger, command: NeedsInfoCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner may ask for more information');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.raisedBy !== 'agent') {
    return failure('invalid', 'more information can be asked only of an item a ferret raised');
  }
  if (target.item.waitingOn !== undefined) return unchanged(ledger);
  const note = command.note?.trim() ?? '';
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AgendaItem = {
    ...current,
    waitingOn: 'ferret',
    askedAt: command.at,
    infoRequests: (target.item.infoRequests ?? 0) + 1,
    history: withHistory(target.item.history, { at: command.at, kind: 'needs-info', ...(note === '' ? {} : { note }) }),
  };
  return replaceItem(ledger, item, command.at, 'needs-info');
}

/**
 * The owner wants to talk an item through before answering it — they do not understand it, or its premise
 * is wrong. The item stays OPEN, waiting on the ferret FOR a discussion (`waitingFor: 'discussion'`), and
 * the request is counted on the same counter as a request for more information (`infoRequests`), so its
 * delivery is exactly once. The ferret's edit ends it like it ends a request for information; so does any
 * closing. Asking again while it is still in discussion is the same request; asking while the ferret owes
 * more information turns that wait into a discussion, a new request.
 */
function discuss(ledger: AgendaLedger, command: DiscussCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner may ask to discuss an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.raisedBy !== 'agent') {
    return failure('invalid', 'only an item a ferret raised can be discussed: nobody else would hear it');
  }
  if (target.item.waitingOn !== undefined && target.item.waitingFor === 'discussion') return unchanged(ledger);
  const note = command.note?.trim() ?? '';
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AgendaItem = {
    ...current,
    waitingOn: 'ferret',
    askedAt: command.at,
    waitingFor: 'discussion',
    infoRequests: (target.item.infoRequests ?? 0) + 1,
    history: withHistory(target.item.history, { at: command.at, kind: 'discuss', ...(note === '' ? {} : { note }) }),
  };
  return replaceItem(ledger, item, command.at, 'discussing');
}

/**
 * The owner's chat message named an open item (`[re !A5 «title»] …`): the item CLOSES for the owner at once, as
 * `replied` — "the owner replied; nothing more is needed unless the ferret asks again" — and their words stay in
 * its history. It leaves every open list, badge and count, so an item the ferret never acts on cannot hang
 * around. Nothing is pushed and `infoRequests` does not move: the owner's message is itself what the ferret reads.
 * The ferret brings it back with `surface` or `edit` (see {@link reopenReplied}) when it needs more.
 * Whatever the item waited on (a discussion, more information) ends with it. Only the owner replies, only an
 * open item is replied to, and a notice is read, not replied to.
 */
function reply(ledger: AgendaLedger, command: ReplyCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner replies to an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not replied to');
  const words = command.note?.trim() ?? '';
  const note = words === '' ? null : words.slice(0, MAX_AGENDA_DETAIL_LENGTH);
  // PARKED, not closed: the item leaves the owner's queue (and any discussion) and waits for the ferret to
  // bring it back or close it. A reply to a snoozed item is a reply too: it parks as replied.
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, parked: _p, ...open } = target.item;
  const item: AgendaItem = {
    ...open,
    parked: { reason: 'replied', at: command.at },
    history: withHistory(open.history, { at: command.at, kind: 'replied', ...(note === null ? {} : { note }) }),
  };
  return replaceItem(ledger, item, command.at, 'replied');
}

/**
 * What a ferret's `edit` or `surface` does to a PARKED item: one parked as `replied` comes back — fresh, so the
 * owner sees it as new; one the owner `snoozed` stays asleep unless the ferret says it is urgent (`now`), and
 * then at most once an hour per item (`AGENDA_URGENT_WAKE_MS`). Anyone else's move, and any item in play, is
 * returned as it is.
 */
function backFromParked(item: AgendaItem, actor: AgendaActor, at: string, now: boolean): AgendaItem | AgendaFailure {
  if (item.parked === undefined || actor.kind !== 'agent') return item;
  if (item.parked.reason === 'snoozed') {
    if (!now) return item;
    if (item.urgentAt !== undefined && Date.parse(at) - Date.parse(item.urgentAt) < AGENDA_URGENT_WAKE_MS) {
      return {
        code: 'rate-limited',
        message: `${item.id} was already woken as urgent at ${item.urgentAt}; the owner snoozed it, so it may be woken again an hour after that`,
      };
    }
  }
  const { parked, ...rest } = item;
  return { ...rest, waitingSince: at, ...(parked.reason === 'snoozed' ? { urgentAt: at } : {}) };
}

/** The owner puts an open item away until a time still ahead: off their queue, back as fresh when it wakes. */
function snooze(ledger: AgendaLedger, command: SnoozeCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner snoozes an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not snoozed');
  if (!(Date.parse(command.until) > Date.parse(command.at))) {
    return failure('invalid', 'snooze an item until a time that is still ahead');
  }
  const item: AgendaItem = { ...target.item, parked: { reason: 'snoozed', at: command.at, until: command.until } };
  return replaceItem(ledger, item, command.at, 'parked');
}

/** The owner brings a parked item (snoozed, or replied to) back to their queue now. */
function unsnooze(ledger: AgendaLedger, command: UnsnoozeCommand): AgendaMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner unsnoozes an item');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.parked === undefined) return unchanged(ledger);
  const { parked: _parked, ...item } = target.item;
  return replaceItem(ledger, item, command.at, 'unparked');
}

/**
 * The daemon's timer wakes a snoozed item whose time has come — its `until`, or its `neededBy` when that is
 * sooner (`agendaWakeAt`): back on the owner's queue, FRESH (`waitingSince` is now), so it reads as new and
 * unread. Only the daemon's own timer wakes an item; an item not yet due, or no longer snoozed, is left alone.
 */
function wake(ledger: AgendaLedger, command: WakeCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon' || command.actor.cause !== 'system') {
    return failure('forbidden', "only the daemon's timer wakes a snoozed item");
  }
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  const due = target === undefined ? null : agendaWakeAt(target.item);
  if (target === undefined || due === null || Date.parse(due) > Date.parse(command.at)) return unchanged(ledger);
  const { parked: _parked, ...item } = target.item;
  return replaceItem(ledger, { ...item, waitingSince: command.at }, command.at, 'woke');
}

/**
 * Why a ferret may not bring back an item the owner replied to as it stands, or `null` when it may: the owner's
 * reply changed what the ask is, so the card must be written again whole — the ask (`subject`), the `premise`
 * and the `context` — to stay an isolated, self-contained statement of what is going on. Restating a field
 * unchanged counts; leaving one out does not. `patch` is `null` for a bare `surface`. Owner and daemon are exempt.
 * An ANSWER TO THE OWNER'S QUESTION (`questionAnswer`) is the exception: the ask has not changed, so the item comes
 * back as it was, with that answer above its own options.
 */
function repliedRefreshProblem(actor: AgendaActor, id: AgendaId, patch: EditAgendaPatch | null): string | null {
  if (actor.kind !== 'agent') return null;
  if (patch === null) {
    return `${id} was replied to: bring it back with the whole card refreshed — \`fy agenda edit ${id} --summary … --premise … --context …\`, not surface`;
  }
  const blank = (field: string | null | undefined): boolean => (field ?? '').trim() === '';
  if (!blank(patch.questionAnswer)) return null;
  const missing = [
    ...(blank(patch.subject) ? ['--summary'] : []),
    ...(blank(patch.premise) ? ['--premise'] : []),
    ...(blank(patch.context) ? ['--context'] : []),
  ];
  return missing.length === 0
    ? null
    : `bring ${id} back with the whole card refreshed: --summary, --premise and --context are required after the owner replied (missing ${missing.join(', ')})`;
}

/**
 * The ferret needs more from the owner after a reply closed the item: it is open again, on the OWNER's turn,
 * with its id, history and edits kept. Called by `surface` (as it stands) and by the ferret's `edit` (with the
 * new wording). Only whoever may close the item may reopen it, and a full board cannot take it back.
 * Returns `undefined` when the item is not a replied one.
 */
function reopenReplied(
  ledger: AgendaLedger,
  id: AgendaId,
  actor: AgendaActor,
  at: string,
  entry: AgendaHistoryEntry,
  patch: EditAgendaPatch | null,
): AgendaMutation | undefined {
  const closed = ledger.entries.find(
    (candidate): candidate is Extract<AgendaEntry, { lifecycle: 'addressed' }> =>
      candidate.lifecycle === 'addressed' && candidate.item.id === id && candidate.item.disposition === 'replied',
  );
  if (closed === undefined) return undefined;
  const allowed = actor.kind === 'daemon' && actor.cause === 'system' ? true : canAddressAgenda(actor, closed);
  if (!allowed) return failure('forbidden', 'only the owner or the ferret that raised an item may bring it back');
  const stale = repliedRefreshProblem(actor, id, patch);
  if (stale !== null) return failure('invalid', stale);
  const active = ledger.entries.filter(isActiveAgenda);
  if (active.length >= MAX_AGENDA_PER_SESSION) {
    return failure('full', `${id} cannot reopen: this board already holds ${MAX_AGENDA_PER_SESSION} open items`);
  }
  const {
    resolvedAt: _resolvedAt,
    resolutionNote: _resolutionNote,
    response: _response,
    disposition: _disposition,
    resolvedBy: _resolvedBy,
    resolvedBySession: _resolvedBySession,
    resolvedByName: _resolvedByName,
    ...rest
  } = closed.item;
  const parsed = AgendaItemSchema.safeParse({ ...rest, history: withHistory(rest.history, entry) });
  if (!parsed.success) return unchanged(ledger);
  const next: AgendaLedger = {
    ...ledger,
    entries: [
      ...active,
      { lifecycle: 'active', origin: closed.origin, item: parsed.data },
      ...ledger.entries.filter(candidate => candidate !== closed && candidate.lifecycle === 'addressed'),
    ],
    updatedAt: at,
  };
  return success(next, true, 'reopened', parsed.data);
}

/**
 * An item leaves discussion for the owner's queue: the owner did not answer it in chat. The raising ferret
 * surfaces it (so does the owner, and the daemon's own timer), and only an open item in discussion moves.
 * An item already in the queue is left as it is, so surfacing twice is surfacing once; an item that waits on
 * the ferret for more information is not in discussion, and is answered by editing it.
 */
function surface(ledger: AgendaLedger, command: SurfaceCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    const why = command.why?.trim() ?? '';
    const reopened = reopenReplied(
      ledger,
      command.id,
      command.actor,
      command.at,
      { at: command.at, kind: 'surfaced', ...(why === '' ? {} : { note: why }) },
      null,
    );
    if (reopened !== undefined) return reopened;
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  // The daemon's resurface timer (`system`) may surface any item; a warden or a source may surface only its own.
  const allowed =
    command.actor.kind === 'daemon' && command.actor.cause === 'system'
      ? true
      : canAddressAgenda(command.actor, target);
  if (!allowed) {
    return failure('forbidden', 'only the owner, the ferret that raised an item, or the daemon timer may surface it');
  }
  if (target.item.parked !== undefined) {
    if (target.item.parked.reason === 'replied') {
      const stale = repliedRefreshProblem(command.actor, command.id, null);
      if (stale !== null) return failure('invalid', stale);
    }
    const back = backFromParked(target.item, command.actor, command.at, command.now === true);
    if ('code' in back) return failure(back.code, back.message);
    if (back === target.item) return unchanged(ledger);
    const why = command.why?.trim() ?? '';
    // Surfacing also ends a discussion the item was in when it was parked: it is the owner's turn now.
    const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = back;
    const item: AgendaItem = {
      ...(back.waitingFor === 'discussion' ? open : back),
      history: withHistory(back.history, { at: command.at, kind: 'surfaced', ...(why === '' ? {} : { note: why }) }),
    };
    return replaceItem(ledger, item, command.at, 'unparked');
  }
  if (target.item.waitingOn === undefined) return unchanged(ledger);
  if (target.item.waitingFor !== 'discussion') {
    return failure('invalid', `${command.id} waits on more information, not on a discussion: edit it instead`);
  }
  const why = command.why?.trim() ?? '';
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
  const item: AgendaItem = {
    ...open,
    history: withHistory(target.item.history, {
      at: command.at,
      kind: 'surfaced',
      ...(why === '' ? {} : { note: why }),
    }),
  };
  return replaceItem(ledger, item, command.at, 'surfaced');
}

/**
 * The owner's action never reached the ferret, so the item goes back to the owner as a card
 * (docs/agenda.md § Delivery). Only the daemon says so, and only of an item a ferret raised.
 *
 * - An ANSWER (or done, or dismiss) that was not delivered: the closed item is OPEN again, with what the
 *   owner did kept in `undelivered` so a retry is one tap. An item no longer in the board's history, or
 *   already open again, is left alone.
 * - A request for more information or to discuss (`request`): the item stops waiting on the ferret, but
 *   only while it is still waiting on THAT request — the ferret may have answered it, or the owner asked
 *   again, since.
 *
 * A board already full of open items keeps the answer closed: the item cannot fit, and refusing is the
 * one honest outcome (the caller records it).
 */
function undelivered(ledger: AgendaLedger, command: UndeliveredCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon may report an undelivered answer');
  const active = ledger.entries.filter(isActiveAgenda);
  if (command.request !== undefined) {
    const target = active.find(entry => entry.item.id === command.id);
    if (target === undefined || target.item.waitingOn === undefined || target.item.infoRequests !== command.request)
      return unchanged(ledger);
    const note = lastNote(target.item.history, target.item.waitingFor === 'discussion' ? 'discuss' : 'needs-info');
    const action = target.item.waitingFor === 'discussion' ? ('discuss' as const) : ('needs-info' as const);
    const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
    const item: AgendaItem = {
      ...open,
      undelivered: {
        at: command.at,
        reply: { action, ...(note === undefined ? {} : { note }) },
        reason: command.reason,
      },
    };
    return replaceItem(ledger, item, command.at, 'reopened');
  }
  if (active.some(entry => entry.item.id === command.id)) return unchanged(ledger);
  const closed = ledger.entries.find(
    (entry): entry is Extract<AgendaEntry, { lifecycle: 'addressed' }> =>
      entry.lifecycle === 'addressed' && entry.item.id === command.id,
  );
  if (closed === undefined || closed.item.raisedBy !== 'agent') return unchanged(ledger);
  if (active.length >= MAX_AGENDA_PER_SESSION)
    return failure(
      'full',
      `${command.id} cannot reopen: this board already holds ${MAX_AGENDA_PER_SESSION} open items`,
    );
  const {
    resolvedAt: _resolvedAt,
    resolutionNote,
    response,
    disposition,
    resolvedBy: _resolvedBy,
    resolvedBySession: _resolvedBySession,
    resolvedByName: _resolvedByName,
    ...rest
  } = closed.item;
  const note = resolutionNote?.trim() === '' ? undefined : (resolutionNote ?? undefined);
  const reply: AgendaUndelivered['reply'] =
    disposition === 'dismissed'
      ? { action: 'dismiss', ...(note === undefined ? {} : { note }) }
      : {
          action: 'resolve',
          ...(note === undefined ? {} : { note }),
          ...(response === undefined ? {} : { response }),
        };
  const parsed = AgendaItemSchema.safeParse({
    ...rest,
    undelivered: { at: command.at, reply, reason: command.reason },
  });
  if (!parsed.success) return unchanged(ledger);
  const next: AgendaLedger = {
    ...ledger,
    entries: [
      ...active,
      { lifecycle: 'active', origin: closed.origin, item: parsed.data },
      ...ledger.entries.filter(entry => entry !== closed && entry.lifecycle === 'addressed'),
    ],
    updatedAt: command.at,
  };
  return success(next, true, 'reopened', parsed.data);
}

/**
 * The held change an item confirms moved on (docs/agenda.md § Confirming a configuration change): the item
 * names the new change and its digest, marked `restated` so the card says it was edited, and its premise is the
 * new change's words — kept as a revision by the daemon. It is the owner's turn again: a wait on the ferret ends.
 * Only the daemon says so, and only of an open item that confirms the same file.
 */
function restateConfirms(ledger: AgendaLedger, command: RestateConfirmsCommand): AgendaMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon may restate a confirmation');
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.confirms?.path !== command.confirms.path) {
    return failure('invalid', `${command.id} does not confirm a change to ${command.confirms.path}`);
  }
  const confirms: AgendaConfirms = { ...command.confirms, restated: true };
  if (sameField(confirms, target.item.confirms) && target.item.premise === command.premise) return unchanged(ledger);
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
  const premiseChanged = target.item.premise !== command.premise;
  const revision: AgendaRevision = {
    at: command.at,
    by: 'daemon',
    changed: ['premise'],
    previous: target.item.premise === undefined ? {} : { premise: target.item.premise },
  };
  const item: AgendaItem = {
    ...open,
    confirms,
    premise: command.premise,
    ...(premiseChanged ? { revisions: [...(target.item.revisions ?? []), revision].slice(-MAX_AGENDA_REVISIONS) } : {}),
  };
  return replaceItem(ledger, item, command.at, 'refreshed');
}

/** The note on the newest history entry of this kind, if it had one. */
function lastNote(
  history: readonly AgendaHistoryEntry[] | undefined,
  kind: AgendaHistoryEntry['kind'],
): string | undefined {
  return history?.findLast(entry => entry.kind === kind)?.note;
}

function stepRange(id: AgendaId, count: number, step: number): string {
  return count === 0 ? `${id} has no steps` : `${id} has steps 0 to ${count - 1}, not ${step}`;
}

function sameSteps(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Ticks or unticks one step of an OPEN item. It is progress, not resolution: the item stays open, nobody
 * is pushed and the ferret is told nothing. The owner may do it, and so may the ferret that raised the item.
 */
function progress(ledger: AgendaLedger, command: ProgressCommand): AgendaMutation {
  const target = ledger.entries.filter(isActiveAgenda).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (!canAddressAgenda(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may tick steps only on an agenda item it raised');
  }
  const count = target.item.steps?.length ?? 0;
  if (command.step >= count) return failure('invalid', stepRange(command.id, count, command.step));
  const before = target.item.stepsDone ?? [];
  if (before.includes(command.step) === command.done) return unchanged(ledger);
  const after = (command.done ? [...before, command.step] : before.filter(step => step !== command.step)).sort(
    (left, right) => left - right,
  );
  const { stepsDone: _previous, ...rest } = target.item;
  const item: AgendaItem = { ...rest, ...(after.length === 0 ? {} : { stepsDone: after }) };
  const next: AgendaLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'progressed', item);
}
