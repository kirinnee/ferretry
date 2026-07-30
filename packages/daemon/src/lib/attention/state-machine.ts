import {
  ATTENTION_SCHEMA_VERSION,
  type AttentionAsk,
  type AttentionErrorCode,
  type AttentionId,
  type AttentionItem,
  type AttentionResponse,
  type AttentionSnapshot,
  type AttentionSource,
  MAX_ATTENTION_PER_SESSION,
  MAX_ATTENTION_RESOLUTIONS,
  type ResolvedAttentionItem,
} from '@ferretry/protocol';

/** Agent-raised requests are capped separately so automatic sources retain board capacity. */
export const MAX_AGENT_ATTENTION_PER_SESSION = 10;

export type DaemonAttentionCause = 'source-reconciliation' | 'warden-escalation' | 'system';

/**
 * Provenance is a tagged value, not a user-supplied collection of nullable fields. The daemon
 * cause deliberately distinguishes warden escalation from ordinary session Attention.
 */
export type AttentionActor =
  | { readonly kind: 'human' }
  | { readonly kind: 'agent'; readonly sessionId: string; readonly name: string | null }
  | { readonly kind: 'daemon'; readonly cause: DaemonAttentionCause };

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

export interface RaiseAttentionRequest {
  readonly source: AttentionSource;
  readonly sourceRef: string | null;
  readonly sourceSeq?: number;
  readonly subject: string;
  readonly why: string;
  readonly context?: string | null;
  readonly waitingSince?: string;
  readonly howToResolve: string;
  readonly ask?: AttentionAsk;
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

export type AttentionChange = 'created' | 'refreshed' | 'answered' | 'resolved' | 'dismissed' | 'unchanged';

export type AttentionMutation =
  | { readonly ok: false; readonly error: AttentionFailure }
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly change: AttentionChange;
      readonly ledger: AttentionLedger;
      readonly snapshot: AttentionSnapshot;
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

function applyToLedger(ledger: AttentionLedger, command: AttentionCommand): AttentionMutation {
  switch (command.action) {
    case 'raise':
      return raise(ledger, command);
    case 'answer':
      return addressById(ledger, command, 'answered', 'done', command.response);
    case 'resolve':
      return addressById(ledger, command, 'resolved', 'done');
    case 'dismiss':
      return addressById(ledger, command, 'dismissed', 'dismissed');
    case 'resolve-source':
      return resolveSource(ledger, command);
  }
}

type RaiseCommand = Extract<AttentionCommand, { action: 'raise' }>;
type AddressCommand = Extract<AttentionCommand, { action: 'answer' | 'resolve' | 'dismiss' }>;
type ResolveSourceCommand = Extract<AttentionCommand, { action: 'resolve-source' }>;

function raise(ledger: AttentionLedger, command: RaiseCommand): AttentionMutation {
  const { actor, request } = command;
  if (request.source !== 'agent-raised' && actor.kind !== 'daemon') {
    return failure('forbidden', `only the daemon may raise attention from source ${request.source}`);
  }
  if (request.sourceRef !== null && actor.kind !== 'daemon') {
    return failure('forbidden', 'stable attention source references are reserved for trusted daemon producers');
  }
  if (request.ask === undefined && actor.kind !== 'daemon') {
    return failure('invalid', 'human and agent attention must declare one of the four structured ask kinds');
  }
  if (request.sourceSeq !== undefined && request.source !== 'agent-raised') {
    return failure('invalid', 'sourceSeq is valid only for agent-raised attention');
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
    return failure('full', 'this session has exhausted its attention id sequence');
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
    },
    actor,
  );
  const next: AttentionLedger = {
    ...ledger,
    nextId: ledger.nextId + 1,
    entries: [...ledger.entries, { lifecycle: 'active', origin: actor, item }],
    updatedAt: command.at,
  };
  return success(next, true, 'created');
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
  };
  const next: AttentionLedger = {
    ...ledger,
    entries: ledger.entries.map(entry =>
      entry.lifecycle === 'active' && entry.item.id === existing.item.id ? { ...entry, item } : entry,
    ),
    updatedAt: command.at,
  };
  return success(next, true, 'refreshed');
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
      : failure('not-found', `no unresolved attention item ${command.id} in this session`);
  }
  if (command.action === 'dismiss') {
    if (!canDismissAttention(command.actor, target)) {
      return failure('forbidden', 'an agent or daemon may dismiss only an attention item it raised');
    }
  } else if (!canAddressAttention(command.actor, target)) {
    return failure('forbidden', 'an agent or daemon may resolve only an attention item it raised');
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
  if (command.action === 'resolve' && target.item.ask !== undefined) {
    return failure(
      'invalid',
      `${command.id} has a structured ask; answer or dismiss it without discarding the response`,
    );
  }
  return addressed(ledger, target, command.actor, command.note ?? null, command.at, disposition, change, response);
}

function resolveSource(ledger: AttentionLedger, command: ResolveSourceCommand): AttentionMutation {
  const target = ledger.entries
    .filter(isActiveAttention)
    .find(entry => entry.item.source === command.source && entry.item.sourceRef === command.sourceRef);
  return target === undefined
    ? unchanged(ledger)
    : addressed(ledger, target, command.actor, command.note ?? null, command.at, 'done', 'resolved');
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
  const item = withResolvedBy(
    {
      ...target.item,
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
  return success(next, true, change);
}

function canAddressAttention(actor: AttentionActor, entry: AttentionEntry): boolean {
  return canDismissAttention(actor, entry);
}

function responseMatchesAsk(ask: AttentionAsk | undefined, response: AttentionResponse): boolean {
  if (ask === undefined || ask.kind !== response.kind) return false;
  if (ask.kind !== 'multiple-choice' || response.kind !== 'multiple-choice') return true;
  return ask.options.some(option => option.label === response.choice);
}

function sameRequest(item: AttentionItem, request: RaiseAttentionRequest): boolean {
  return (
    item.subject === request.subject &&
    item.why === request.why &&
    (item.context ?? null) === (request.context ?? null) &&
    item.howToResolve === request.howToResolve &&
    JSON.stringify(item.ask ?? null) === JSON.stringify(request.ask ?? null)
  );
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

function success(ledger: AttentionLedger, changed: boolean, change: AttentionChange): AttentionMutation {
  return { ok: true, changed, change, ledger, snapshot: attentionSnapshot(ledger) };
}

function failure(code: AttentionErrorCode, message: string): AttentionMutation {
  return { ok: false, error: { code, message } };
}
