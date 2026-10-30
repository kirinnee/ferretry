import {
  ATTENTION_SCHEMA_VERSION,
  type AttentionAsk,
  type AttentionBrief,
  type AttentionClearableField,
  type AttentionCardAnswer,
  type AttentionErrorCode,
  type AttentionHistoryEntry,
  type AttentionId,
  type AttentionItem,
  AttentionItemSchema,
  type AttentionKind,
  type AttentionRevisableField,
  type AttentionRevision,
  type AttentionResponse,
  type AttentionSnapshot,
  type AttentionSource,
  type AttentionUndelivered,
  attentionBriefOf,
  attentionNoticeProblems,
  MAX_ATTENTION_HISTORY,
  MAX_ATTENTION_PER_SESSION,
  MAX_ATTENTION_REVISIONS,
  MAX_ATTENTION_RESOLUTIONS,
  type ResolvedAttentionItem,
  ResolvedAttentionItemSchema,
} from '@ferretry/protocol';

/** Agent-raised requests are capped separately so automatic sources retain board capacity. */
export const MAX_AGENT_ATTENTION_PER_SESSION = 10;

export type DaemonAttentionCause = 'source-reconciliation' | 'warden-escalation' | 'system' | 'harness-prompt';

/**
 * Provenance is a tagged value, not a user-supplied collection of nullable fields. The daemon
 * cause deliberately distinguishes warden escalation from ordinary session Attention.
 */
export type AttentionActor =
  | { readonly kind: 'human' }
  | { readonly kind: 'agent'; readonly sessionId: string; readonly name: string | null }
  | { readonly kind: 'daemon'; readonly cause: DaemonAttentionCause };

/** Whether an agent actor is confined to the board or session it is trying to change. */
export function agentConfinedTo(actor: AttentionActor, sessionId: string): boolean {
  return actor.kind !== 'agent' || actor.sessionId === sessionId;
}

export type AttentionEntry =
  | { readonly lifecycle: 'active'; readonly origin: AttentionActor; readonly item: AttentionItem }
  | { readonly lifecycle: 'addressed'; readonly origin: AttentionActor; readonly item: ResolvedAttentionItem };

/** Internal durable state. Active state and count are both derived from the entry lifecycle. */
export interface AttentionLedger {
  readonly sessionId: string;
  readonly nextId: number;
  readonly entries: readonly AttentionEntry[];
  readonly updatedAt: string;
}

/** The card an item is: what it is about, its kind and its answers by direction (all derived when absent). */
export interface AttentionCardFields {
  readonly title?: string;
  readonly kind?: AttentionKind;
  readonly answers?: AttentionCardAnswer[];
}

/** A raise carries the item's card and structured brief (the ask line is the `subject`) alongside its ask. */
export interface RaiseAttentionRequest extends AttentionBrief, AttentionCardFields {
  readonly source: AttentionSource;
  readonly sourceRef: string | null;
  readonly sourceSeq?: number;
  readonly subject: string;
  readonly why: string;
  readonly context?: string | null;
  readonly waitingSince?: string;
  readonly howToResolve: string;
  readonly ask?: AttentionAsk;
  /** A plain notification (`fy notify`): kind info, no ask, never a turn. */
  readonly notice?: true;
  /** The notice asks the phone to buzz; only a notice can. */
  readonly ping?: true;
}

/** The writing an edit may change: never the ask, the kind, the answers, the reason or who raised the item. */
export interface EditAttentionPatch extends AttentionBrief {
  readonly subject?: string;
  readonly title?: string;
  readonly context?: string | null;
  /** Agenda fields to take off the item (`--not-blocking`, `--clear-will-block`, `--clear-by`). */
  readonly clear?: readonly AttentionClearableField[];
}

export type AttentionCommand =
  | {
      readonly action: 'raise';
      readonly actor: AttentionActor;
      readonly request: RaiseAttentionRequest;
      readonly at: string;
    }
  | {
      readonly action: 'answer';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly response: AttentionResponse;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'resolve';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'dismiss';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'edit';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly patch: EditAttentionPatch;
      readonly at: string;
    }
  | {
      readonly action: 'progress';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly step: number;
      readonly done: boolean;
      readonly at: string;
    }
  | {
      readonly action: 'needs-info';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      readonly action: 'discuss';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly note?: string | null;
      readonly at: string;
    }
  | {
      /**
       * The owner's chat message named this open item (`[re !A5 «title»] …`): it is now the FERRET's turn. Nothing
       * resolves and nobody is pushed — the message itself is the delivery. Only the owner replies.
       */
      readonly action: 'reply';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly at: string;
    }
  | {
      /** An item leaves discussion for the owner's queue; `why` is the one line kept in its history. */
      readonly action: 'surface';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly why?: string | null;
      readonly at: string;
    }
  | {
      /**
       * The owner's action on an agent-raised item never reached the ferret (docs/attention.md § Delivery):
       * the item is open again, as a card, with what the owner did kept for a retry. `request` names the
       * request for more information or to discuss it that was not delivered; absent for an answer.
       */
      readonly action: 'undelivered';
      readonly actor: AttentionActor;
      readonly id: AttentionId;
      readonly request?: number;
      readonly reason: string;
      readonly at: string;
    }
  | {
      readonly action: 'resolve-source';
      readonly actor: AttentionActor;
      readonly source: AttentionSource;
      readonly sourceRef: string;
      readonly note?: string | null;
      readonly at: string;
    };

export interface AttentionFailure {
  readonly code: AttentionErrorCode;
  readonly message: string;
}

export type AttentionChange =
  | 'created'
  | 'refreshed'
  | 'progressed'
  | 'needs-info'
  | 'discussing'
  | 'replied'
  | 'surfaced'
  | 'info-added'
  | 'reopened'
  | 'answered'
  | 'resolved'
  | 'dismissed'
  | 'unchanged';

export type AttentionMutation =
  | { readonly ok: false; readonly error: AttentionFailure }
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly change: AttentionChange;
      readonly ledger: AttentionLedger;
      readonly snapshot: AttentionSnapshot;
      /** The item on every change that leaves it open; absent for the ones that close it. */
      readonly item?: AttentionItem;
      /** The item as it was closed, on answered, resolved and dismissed mutations; absent otherwise. */
      readonly addressed?: ResolvedAttentionItem;
    };

export function emptyAttentionLedger(sessionId: string, at: string): AttentionLedger {
  return { sessionId, nextId: 1, entries: [], updatedAt: at };
}

export function isActiveAttention(entry: AttentionEntry): entry is Extract<AttentionEntry, { lifecycle: 'active' }> {
  return entry.lifecycle === 'active';
}

export function isWardenEscalationAttention(entry: AttentionEntry): boolean {
  return entry.origin.kind === 'daemon' && entry.origin.cause === 'warden-escalation';
}

export function canDismissAttention(actor: AttentionActor, entry: AttentionEntry): boolean {
  if (actor.kind === 'human') return true;
  if (actor.kind === 'agent') {
    return entry.origin.kind === 'agent' && entry.origin.sessionId === actor.sessionId;
  }
  return entry.origin.kind === 'daemon';
}

export function attentionSnapshot(ledger: AttentionLedger): AttentionSnapshot {
  const items = ledger.entries
    .filter(isActiveAttention)
    .map(entry => entry.item)
    .sort(compareActive);
  const resolved = ledger.entries
    .filter((entry): entry is Extract<AttentionEntry, { lifecycle: 'addressed' }> => !isActiveAttention(entry))
    .map(entry => entry.item)
    .sort(compareAddressed);

  return {
    v: ATTENTION_SCHEMA_VERSION,
    sessionId: ledger.sessionId,
    items,
    resolved,
    count: items.length,
    parseErrors: 0,
    updatedAt: ledger.updatedAt,
  };
}

export function applyAttentionCommand(current: AttentionLedger, command: AttentionCommand): AttentionMutation {
  return applyToLedger(current, command);
}

/** Apply a command for a known board without making the session id part of every command. */
export function applyAttentionCommandToSession(
  current: AttentionLedger | null,
  sessionId: string,
  command: AttentionCommand,
): AttentionMutation {
  return applyToLedger(current ?? emptyAttentionLedger(sessionId, command.at), command);
}

/**
 * Decodes the internal durable form before an adapter supplies it to the state
 * machine. Keeping this validation in the pure layer prevents corrupt storage
 * from being silently replaced by a fresh board.
 */
export function parseAttentionLedger(value: unknown, sessionId: string): AttentionLedger | null {
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
  const entries: AttentionEntry[] = [];
  const ids = new Set<string>();
  let maxId = 0;
  let active = 0;
  let agentActive = 0;
  let addressed = 0;
  for (const rawEntry of raw.entries) {
    const entry = parseAttentionEntry(rawEntry);
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
    active > MAX_ATTENTION_PER_SESSION ||
    agentActive > MAX_AGENT_ATTENTION_PER_SESSION ||
    addressed > MAX_ATTENTION_RESOLUTIONS
  ) {
    return null;
  }
  return { sessionId, nextId: raw.nextId as number, entries, updatedAt: raw.updatedAt };
}

function applyToLedger(ledger: AttentionLedger, command: AttentionCommand): AttentionMutation {
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
    case 'undelivered':
      return undelivered(ledger, command);
    case 'resolve-source':
      return resolveSource(ledger, command);
  }
}

type RaiseCommand = Extract<AttentionCommand, { action: 'raise' }>;
type AddressCommand = Extract<AttentionCommand, { action: 'answer' | 'resolve' | 'dismiss' }>;
type EditCommand = Extract<AttentionCommand, { action: 'edit' }>;
type ProgressCommand = Extract<AttentionCommand, { action: 'progress' }>;
type NeedsInfoCommand = Extract<AttentionCommand, { action: 'needs-info' }>;
type DiscussCommand = Extract<AttentionCommand, { action: 'discuss' }>;
type ReplyCommand = Extract<AttentionCommand, { action: 'reply' }>;
type SurfaceCommand = Extract<AttentionCommand, { action: 'surface' }>;
type ResolveSourceCommand = Extract<AttentionCommand, { action: 'resolve-source' }>;
type UndeliveredCommand = Extract<AttentionCommand, { action: 'undelivered' }>;

function raise(ledger: AttentionLedger, command: RaiseCommand): AttentionMutation {
  const { actor, request } = command;
  if (request.source !== 'agent-raised' && actor.kind !== 'daemon') {
    return failure('forbidden', `only the daemon may raise an agenda item from source ${request.source}`);
  }
  if (request.sourceRef !== null && actor.kind !== 'daemon') {
    return failure('forbidden', 'stable agenda source references are reserved for trusted daemon producers');
  }
  const noticeProblem = attentionNoticeProblems(request)[0];
  if (noticeProblem !== undefined) return failure('invalid', noticeProblem);
  if (request.notice === true && actor.kind === 'human') {
    return failure('forbidden', 'only a ferret or the daemon sends a notice');
  }
  if (request.ask === undefined && request.kind !== 'info' && request.notice !== true && actor.kind !== 'daemon') {
    return failure(
      'invalid',
      'human and agent agenda items must declare a structured ask, or be kind info (something to know, no ask)',
    );
  }
  if (request.sourceSeq !== undefined && request.source !== 'agent-raised') {
    return failure('invalid', 'sourceSeq is valid only for agent-raised agenda items');
  }

  const active = ledger.entries.filter(isActiveAttention);
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

  if (active.length >= MAX_ATTENTION_PER_SESSION) {
    return failure('full', `this session already has ${MAX_ATTENTION_PER_SESSION} unresolved items`);
  }
  if (
    actor.kind === 'agent' &&
    active.filter(entry => entry.origin.kind === 'agent').length >= MAX_AGENT_ATTENTION_PER_SESSION
  ) {
    return failure('full', `this session already has ${MAX_AGENT_ATTENTION_PER_SESSION} unresolved agent requests`);
  }
  if (!Number.isSafeInteger(ledger.nextId) || ledger.nextId < 1 || ledger.nextId >= Number.MAX_SAFE_INTEGER) {
    return failure('full', 'this session has exhausted its agenda id sequence');
  }

  const item = withRaisedBy(
    {
      id: `A${ledger.nextId}` as AttentionId,
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
      ...attentionBriefOf(request),
      // A new ask is the OWNER's turn: no `waitingOn`. The ferret's turn begins only when the owner replies.
      ...(request.notice === true ? { notice: true as const } : {}),
      ...(request.ping === true ? { ping: true as const } : {}),
    },
    actor,
  );
  const next: AttentionLedger = {
    ...ledger,
    nextId: ledger.nextId + 1,
    entries: [...ledger.entries, { lifecycle: 'active', origin: actor, item }],
    updatedAt: command.at,
  };
  return success(next, true, 'created', item);
}

function refreshStable(
  ledger: AttentionLedger,
  existing: Extract<AttentionEntry, { lifecycle: 'active' }>,
  command: RaiseCommand,
): AttentionMutation {
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

  const item: AttentionItem = {
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
    // Ticks belong to the steps they were made on: the same steps keep them, new steps start clean.
    stepsDone: sameSteps(existing.item.steps, request.steps) ? existing.item.stepsDone : undefined,
  };
  const next: AttentionLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === existing.item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'refreshed', item);
}

function addressById(
  ledger: AttentionLedger,
  command: AddressCommand,
  change: Extract<AttentionChange, 'answered' | 'resolved' | 'dismissed'>,
  disposition: 'done' | 'dismissed',
  response?: AttentionResponse,
): AttentionMutation {
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  if (command.action === 'dismiss') {
    if (!canDismissAttention(command.actor, target)) {
      return failure('forbidden', 'an agent or daemon may dismiss only an agenda item it raised');
    }
  } else if (!canAddressAttention(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may resolve only an agenda item it raised');
  }
  if (command.action === 'answer') {
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
  return addressed(ledger, target, command.actor, command.note ?? null, command.at, disposition, change, response);
}

function resolveSource(ledger: AttentionLedger, command: ResolveSourceCommand): AttentionMutation {
  if (command.actor.kind !== 'daemon') {
    return failure('forbidden', 'only the daemon may reconcile a trusted agenda source');
  }
  const target = ledger.entries
    .filter(isActiveAttention)
    .find(entry => entry.item.source === command.source && entry.item.sourceRef === command.sourceRef);
  return target === undefined
    ? unchanged(ledger)
    : addressed(ledger, target, command.actor, command.note ?? null, command.at, 'done', 'resolved');
}

function parseAttentionEntry(value: unknown): AttentionEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const origin = parseAttentionActor(raw.origin);
  if (origin === null) return null;
  if (raw.lifecycle === 'active') {
    const item = AttentionItemSchema.safeParse(raw.item);
    return item.success && sameItemOrigin(item.data, origin) ? { lifecycle: 'active', origin, item: item.data } : null;
  }
  if (raw.lifecycle === 'addressed') {
    const item = ResolvedAttentionItemSchema.safeParse(raw.item);
    return item.success && sameItemOrigin(item.data, origin)
      ? { lifecycle: 'addressed', origin, item: item.data }
      : null;
  }
  return null;
}

function parseAttentionActor(value: unknown): AttentionActor | null {
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
  if (
    raw.kind === 'daemon' &&
    (raw.cause === 'source-reconciliation' ||
      raw.cause === 'warden-escalation' ||
      raw.cause === 'system' ||
      raw.cause === 'harness-prompt')
  ) {
    return { kind: 'daemon', cause: raw.cause };
  }
  return null;
}

function sameItemOrigin(item: AttentionItem | ResolvedAttentionItem, origin: AttentionActor): boolean {
  return (
    item.raisedBy === origin.kind &&
    item.raisedBySession === (origin.kind === 'agent' ? origin.sessionId : null) &&
    item.raisedByName === (origin.kind === 'agent' ? origin.name : null)
  );
}

function addressed(
  ledger: AttentionLedger,
  target: Extract<AttentionEntry, { lifecycle: 'active' }>,
  actor: AttentionActor,
  note: string | null,
  at: string,
  disposition: 'done' | 'dismissed',
  change: Extract<AttentionChange, 'answered' | 'resolved' | 'dismissed'>,
  response?: AttentionResponse,
): AttentionMutation {
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
      resolvedAt: at,
      resolutionNote: note,
      disposition,
      ...(response === undefined ? {} : { response }),
    },
    actor,
  );
  const active = ledger.entries.filter(
    (entry): entry is Extract<AttentionEntry, { lifecycle: 'active' }> =>
      entry.lifecycle === 'active' && entry.item.id !== target.item.id,
  );
  const history = [
    { lifecycle: 'addressed' as const, origin: target.origin, item },
    ...ledger.entries.filter(
      (entry): entry is Extract<AttentionEntry, { lifecycle: 'addressed' }> => entry.lifecycle === 'addressed',
    ),
  ].slice(0, MAX_ATTENTION_RESOLUTIONS);
  const next: AttentionLedger = { ...ledger, entries: [...active, ...history], updatedAt: at };
  return success(next, true, change, undefined, item);
}

function canAddressAttention(actor: AttentionActor, entry: AttentionEntry): boolean {
  return canDismissAttention(actor, entry);
}

function responseMatchesAsk(ask: AttentionAsk | undefined, response: AttentionResponse): boolean {
  if (ask === undefined) return false;
  // The owner's own words instead of the options: any ask that offers options takes them.
  if (response.kind === 'other') return ask.kind !== 'open-question' && ask.kind !== 'task';
  if (ask.kind !== response.kind) return false;
  if (ask.kind !== 'multiple-choice' || response.kind !== 'multiple-choice') return true;
  return ask.options.some(option => option.label === response.choice);
}

function sameRequest(item: AttentionItem, request: RaiseAttentionRequest): boolean {
  return (
    item.subject === request.subject &&
    item.why === request.why &&
    (item.context ?? null) === (request.context ?? null) &&
    item.howToResolve === request.howToResolve &&
    JSON.stringify(item.ask ?? null) === JSON.stringify(request.ask ?? null) &&
    item.notice === request.notice &&
    item.ping === request.ping &&
    JSON.stringify(cardFieldsOf(item)) === JSON.stringify(cardFieldsOf(request)) &&
    JSON.stringify(attentionBriefOf(item)) === JSON.stringify(attentionBriefOf(request))
  );
}

/** Just the card fields a request or item carries, in one fixed key order, the absent ones left out. */
function cardFieldsOf(value: AttentionCardFields): AttentionCardFields {
  return {
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.kind === undefined ? {} : { kind: value.kind }),
    ...(value.answers === undefined ? {} : { answers: value.answers }),
  };
}

function sameOrigin(left: AttentionActor, right: AttentionActor): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'human' && right.kind === 'human') return true;
  if (left.kind === 'agent' && right.kind === 'agent') return left.sessionId === right.sessionId;
  return left.kind === 'daemon' && right.kind === 'daemon' && left.cause === right.cause;
}

function withRaisedBy(
  item: Omit<AttentionItem, 'raisedBy' | 'raisedBySession' | 'raisedByName'>,
  actor: AttentionActor,
): AttentionItem {
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
  item: Omit<ResolvedAttentionItem, 'resolvedBy' | 'resolvedBySession' | 'resolvedByName'>,
  actor: AttentionActor,
): ResolvedAttentionItem {
  switch (actor.kind) {
    case 'human':
      return { ...item, resolvedBy: 'human', resolvedBySession: null, resolvedByName: null } as ResolvedAttentionItem;
    case 'agent':
      return {
        ...item,
        resolvedBy: 'agent',
        resolvedBySession: actor.sessionId,
        resolvedByName: actor.name,
      } as ResolvedAttentionItem;
    case 'daemon':
      return { ...item, resolvedBy: 'daemon', resolvedBySession: null, resolvedByName: null } as ResolvedAttentionItem;
  }
}

function idNumber(id: AttentionId): number {
  return Number(id.slice(1));
}

function compareActive(left: AttentionItem, right: AttentionItem): number {
  return left.waitingSince.localeCompare(right.waitingSince) || idNumber(left.id) - idNumber(right.id);
}

function compareAddressed(left: ResolvedAttentionItem, right: ResolvedAttentionItem): number {
  return right.resolvedAt.localeCompare(left.resolvedAt) || idNumber(left.id) - idNumber(right.id);
}

function unchanged(ledger: AttentionLedger): AttentionMutation {
  return success(ledger, false, 'unchanged');
}

function success(
  ledger: AttentionLedger,
  changed: boolean,
  change: AttentionChange,
  item?: AttentionItem,
  addressed?: ResolvedAttentionItem,
): AttentionMutation {
  return {
    ok: true,
    changed,
    change,
    ledger,
    snapshot: attentionSnapshot(ledger),
    ...(item === undefined ? {} : { item }),
    ...(addressed === undefined ? {} : { addressed }),
  };
}

function failure(code: AttentionErrorCode, message: string): AttentionMutation {
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
  'impact',
  'urgency',
  'blockingNow',
  'willBlock',
  'neededBy',
  'links',
  'steps',
  'body',
] as const satisfies readonly AttentionRevisableField[];

/** The option labels of each question, in order — what an edit must leave alone to keep the ask true. */
function questionShape(questions: AttentionBrief['questions']): string {
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
function edit(ledger: AttentionLedger, command: EditCommand): AttentionMutation {
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (!canAddressAttention(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may edit only an agenda item it raised');
  }
  const patch = command.patch;
  const clears = (patch.clear ?? []).filter(field => target.item[field] !== undefined);
  if (EDITABLE_FIELDS.every(field => patch[field] === undefined) && (patch.clear ?? []).length === 0) {
    return failure('invalid', `nothing to edit: give at least one of ${EDITABLE_FIELDS.join(', ')}`);
  }
  if (patch.questions !== undefined && questionShape(patch.questions) !== questionShape(target.item.questions)) {
    return failure('invalid', 'questions may be reworded but not added, removed or given other options');
  }
  const changed = EDITABLE_FIELDS.filter(
    field =>
      clears.some(cleared => cleared === field) ||
      (patch[field] !== undefined && !sameField(patch[field], target.item[field])),
  );
  // The ferret's edit answers its turn: the item goes back to the owner, whether or not the words changed.
  const handsBack = target.item.waitingOn !== undefined && command.actor.kind === 'agent';
  if (changed.length === 0 && !handsBack) return unchanged(ledger);
  const { stepsDone, waitingOn: _waitingOn, askedAt: _askedAt, waitingFor: _waitingFor, ...kept } = target.item;
  const revision: AttentionRevision = {
    at: command.at,
    by: command.actor.kind,
    changed,
    previous: Object.fromEntries(
      changed.flatMap(field => (target.item[field] === undefined ? [] : [[field, target.item[field]]])),
    ),
  };
  const edited: AttentionItem = {
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
      : { revisions: [...(target.item.revisions ?? []), revision].slice(-MAX_ATTENTION_REVISIONS) }),
  };
  const final: AttentionItem = handsBack
    ? { ...edited, history: withHistory(edited.history, { at: command.at, kind: 'updated' }) }
    : edited;
  // Only an answer to a request for MORE INFORMATION is `info-added`; a discussion handed back is a plain refresh.
  const change = handsBack && target.item.waitingFor !== 'discussion' ? 'info-added' : 'refreshed';
  return replaceItem(ledger, final, command.at, change);
}

function replaceItem(
  ledger: AttentionLedger,
  item: AttentionItem,
  at: string,
  change: Extract<
    AttentionChange,
    'refreshed' | 'needs-info' | 'discussing' | 'replied' | 'surfaced' | 'info-added' | 'reopened'
  >,
): AttentionMutation {
  const next: AttentionLedger = {
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
  history: readonly AttentionHistoryEntry[] | undefined,
  entry: AttentionHistoryEntry,
): AttentionHistoryEntry[] {
  return [...(history ?? []), entry].slice(-MAX_ATTENTION_HISTORY);
}

/**
 * The owner asks the raising ferret for more information. The item stays OPEN, marked waiting on the
 * ferret, and each request is counted (`infoRequests`) so the delivery and the push after it are exactly
 * once per request. Only the owner asks, and only of an item a ferret raised: nobody else can be asked.
 * Asking again while the ferret has not yet answered is the same request.
 */
function needsInfo(ledger: AttentionLedger, command: NeedsInfoCommand): AttentionMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner may ask for more information');
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.raisedBy !== 'agent') {
    return failure('invalid', 'more information can be asked only of an item a ferret raised');
  }
  if (target.item.waitingOn !== undefined) return unchanged(ledger);
  const note = command.note?.trim() ?? '';
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AttentionItem = {
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
function discuss(ledger: AttentionLedger, command: DiscussCommand): AttentionMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner may ask to discuss an item');
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.raisedBy !== 'agent') {
    return failure('invalid', 'only an item a ferret raised can be discussed: nobody else would hear it');
  }
  if (target.item.waitingOn !== undefined && target.item.waitingFor === 'discussion') return unchanged(ledger);
  const note = command.note?.trim() ?? '';
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AttentionItem = {
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
 * The owner's chat message named an open item: the item is now the FERRET's turn (internally
 * `waitingOn: 'ferret'`, `waitingFor: 'discussion'`). Nothing resolves, `infoRequests` does not move and
 * nobody is pushed or messaged by this change — the owner's message is itself what the ferret reads. The
 * ferret's `edit`, a `surface`, or any closing hands it back. A reply to an item already on the ferret's
 * turn is no change; one that finds the ferret owing more information turns that wait into a discussion.
 * Only the owner replies, and only an open item is replied to.
 */
function reply(ledger: AttentionLedger, command: ReplyCommand): AttentionMutation {
  if (command.actor.kind !== 'human') return failure('forbidden', 'only the owner replies to an item');
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (target.item.notice === true) return failure('invalid', 'a notice is read, not replied to');
  if (target.item.waitingOn !== undefined && target.item.waitingFor === 'discussion') return unchanged(ledger);
  const { undelivered: _undelivered, ...current } = target.item;
  const item: AttentionItem = {
    ...current,
    waitingOn: 'ferret',
    askedAt: command.at,
    waitingFor: 'discussion',
  };
  return replaceItem(ledger, item, command.at, 'replied');
}

/**
 * An item leaves discussion for the owner's queue: the owner did not answer it in chat. The raising ferret
 * surfaces it (so does the owner, and the daemon's own timer), and only an open item in discussion moves.
 * An item already in the queue is left as it is, so surfacing twice is surfacing once; an item that waits on
 * the ferret for more information is not in discussion, and is answered by editing it.
 */
function surface(ledger: AttentionLedger, command: SurfaceCommand): AttentionMutation {
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) {
    return ledger.entries.some(entry => entry.lifecycle === 'addressed' && entry.item.id === command.id)
      ? unchanged(ledger)
      : failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  }
  // The daemon's resurface timer (`system`) may surface any item; a warden or a source may surface only its own.
  const allowed =
    command.actor.kind === 'daemon' && command.actor.cause === 'system'
      ? true
      : canAddressAttention(command.actor, target);
  if (!allowed) {
    return failure('forbidden', 'only the owner, the ferret that raised an item, or the daemon timer may surface it');
  }
  if (target.item.waitingOn === undefined) return unchanged(ledger);
  if (target.item.waitingFor !== 'discussion') {
    return failure('invalid', `${command.id} waits on more information, not on a discussion: edit it instead`);
  }
  const why = command.why?.trim() ?? '';
  const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
  const item: AttentionItem = {
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
 * (docs/attention.md § Delivery). Only the daemon says so, and only of an item a ferret raised.
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
function undelivered(ledger: AttentionLedger, command: UndeliveredCommand): AttentionMutation {
  if (command.actor.kind !== 'daemon') return failure('forbidden', 'only the daemon may report an undelivered answer');
  const active = ledger.entries.filter(isActiveAttention);
  if (command.request !== undefined) {
    const target = active.find(entry => entry.item.id === command.id);
    if (target === undefined || target.item.waitingOn === undefined || target.item.infoRequests !== command.request)
      return unchanged(ledger);
    const note = lastNote(target.item.history, target.item.waitingFor === 'discussion' ? 'discuss' : 'needs-info');
    const action = target.item.waitingFor === 'discussion' ? ('discuss' as const) : ('needs-info' as const);
    const { waitingOn: _w, askedAt: _a, waitingFor: _f, ...open } = target.item;
    const item: AttentionItem = {
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
    (entry): entry is Extract<AttentionEntry, { lifecycle: 'addressed' }> =>
      entry.lifecycle === 'addressed' && entry.item.id === command.id,
  );
  if (closed === undefined || closed.item.raisedBy !== 'agent') return unchanged(ledger);
  if (active.length >= MAX_ATTENTION_PER_SESSION)
    return failure(
      'full',
      `${command.id} cannot reopen: this board already holds ${MAX_ATTENTION_PER_SESSION} open items`,
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
  const reply: AttentionUndelivered['reply'] =
    disposition === 'dismissed'
      ? { action: 'dismiss', ...(note === undefined ? {} : { note }) }
      : {
          action: 'resolve',
          ...(note === undefined ? {} : { note }),
          ...(response === undefined ? {} : { response }),
        };
  const parsed = AttentionItemSchema.safeParse({
    ...rest,
    undelivered: { at: command.at, reply, reason: command.reason },
  });
  if (!parsed.success) return unchanged(ledger);
  const next: AttentionLedger = {
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

/** The note on the newest history entry of this kind, if it had one. */
function lastNote(
  history: readonly AttentionHistoryEntry[] | undefined,
  kind: AttentionHistoryEntry['kind'],
): string | undefined {
  return history?.findLast(entry => entry.kind === kind)?.note;
}

function stepRange(id: AttentionId, count: number, step: number): string {
  return count === 0 ? `${id} has no steps` : `${id} has steps 0 to ${count - 1}, not ${step}`;
}

function sameSteps(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Ticks or unticks one step of an OPEN item. It is progress, not resolution: the item stays open, nobody
 * is pushed and the ferret is told nothing. The owner may do it, and so may the ferret that raised the item.
 */
function progress(ledger: AttentionLedger, command: ProgressCommand): AttentionMutation {
  const target = ledger.entries.filter(isActiveAttention).find(entry => entry.item.id === command.id);
  if (target === undefined) return failure('not-found', `no unresolved agenda item ${command.id} in this session`);
  if (!canAddressAttention(command.actor, target)) {
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
  const item: AttentionItem = { ...rest, ...(after.length === 0 ? {} : { stepsDone: after }) };
  const next: AttentionLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'progressed', item);
}
