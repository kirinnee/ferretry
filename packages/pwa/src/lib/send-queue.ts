// THE DURABLE QUEUE, BROWSER SIDE.
//
// A message to a ferret is written to the session's queue before anything is typed (docs/message-delivery.md,
// "The durable queue"). The queue owns the first ticks — ✓ queued, then typing — and the send ledger owns the
// rest once the message is handed over, under the SAME id. This module reads the queue and JOINS it to the
// ledger rows, so one message is one bubble for its whole life.

import { type IFyApiClient, type QueuedMessage, QueueEditRequestSchema, SessionQueueSchema } from '@ferretry/protocol';
import { z } from 'zod';
import type { LedgerSendRecord } from './send-ledger.ts';

/** What the queue says about one message — the part of a `QueuedMessage` a bubble draws. */
export interface QueueView {
  readonly state: QueuedMessage['state'];
  readonly stateAt: string;
  readonly revision: number;
  readonly waitReason?: NonNullable<QueuedMessage['waitReason']>;
  readonly failure?: string;
}

/** How long one queue read may take; it rides the same poll as the ledger. */
const QUEUE_READ_TIMEOUT_MS = 20_000;

const queuePath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/queue`;

const statusOf = (reason: unknown): number | undefined =>
  typeof reason === 'object' && reason !== null && typeof (reason as { status?: unknown }).status === 'number'
    ? (reason as { status: number }).status
    : undefined;

/**
 * One read of a session's queue. A daemon from before the queue answers 404 (or 405) for the route: that
 * is "no queue", never an error, so an older machine keeps showing exactly what it showed before.
 * A page this bundle cannot parse is also "no queue": the ledger rows stand on their own.
 */
export const readSessionQueue = async (
  api: Pick<IFyApiClient, 'request'>,
  sessionId: string,
): Promise<readonly QueuedMessage[]> => {
  try {
    const raw = await api.request(queuePath(sessionId), z.unknown(), {}, QUEUE_READ_TIMEOUT_MS);
    const parsed = SessionQueueSchema.safeParse(raw);
    return parsed.success ? parsed.data.messages : [];
  } catch (reason) {
    const status = statusOf(reason);
    if (status === 404 || status === 405) return [];
    throw reason;
  }
};

/** The queue message states that mean the agent has the message. */
const isQueueArrived = (state: QueuedMessage['state']): boolean => state === 'delivered' || state === 'read';

const viewOf = (message: QueuedMessage): QueueView => ({
  state: message.state,
  stateAt: message.stateAt,
  revision: message.revision,
  ...(message.waitReason === undefined ? {} : { waitReason: message.waitReason }),
  ...(message.failure === undefined ? {} : { failure: message.failure }),
});

/** The ledger fate a queue state stands for, so placement and the actions treat a queue-only row like a ledger one. */
const fateOf = (state: QueuedMessage['state']): LedgerSendRecord['fate'] => {
  switch (state) {
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'timed_out';
    default:
      return 'accepted';
  }
};

const synthesize = (message: QueuedMessage): LedgerSendRecord => ({
  sendId: message.id,
  acceptedAt: message.enqueuedAt,
  message: message.text,
  attachmentIds: message.attachmentIds,
  fate: fateOf(message.state),
  senderKind: message.sender,
  ...(message.from === undefined ? {} : { from: message.from }),
  ...(message.fromName === undefined ? {} : { fromName: message.fromName }),
  ...(message.replyExpected === true ? { replyExpected: true as const } : {}),
  ...(message.state === 'queued' || message.state === 'typing' ? {} : { fateAt: message.stateAt }),
  queue: viewOf(message),
});

/** The row's fate once the queue has had its say. Delivered wins from either side; a person's own ledger cancel stays. */
const joinedFate = (row: LedgerSendRecord, state: QueuedMessage['state']): LedgerSendRecord['fate'] => {
  if (row.fate === 'delivered' || isQueueArrived(state)) return 'delivered';
  if (row.fate === 'cancelled') return 'cancelled';
  if (state === 'cancelled' || state === 'failed') return fateOf(state);
  return row.fate === 'timed_out' || row.fate === 'unaccounted' ? 'accepted' : row.fate;
};

/** Takes the pieces of a ledger row that contradict "the agent has it" off a row that arrived. */
const joinedRow = (row: LedgerSendRecord, message: QueuedMessage): LedgerSendRecord => {
  const view = viewOf(message);
  const fate = joinedFate(row, message.state);
  if (fate === 'delivered') {
    const { unread: _unread, held: _held, typedNotSent: _typed, retryable: _retryable, ...rest } = row;
    return {
      ...rest,
      fate,
      fateAt: row.fate === 'delivered' ? (row.fateAt ?? view.stateAt) : view.stateAt,
      queue: view,
    };
  }
  if (fate === row.fate) return { ...row, queue: view };
  return { ...row, fate, fateAt: view.stateAt, queue: view };
};

/**
 * Joins the queue to the ledger by id.
 *
 *   * A ledger row whose id is a queue message wears the queue's view. A queue state of delivered or read
 *     WINS over any ledger fate (the owner's "not delivered" bug: the agent had it); a ledger that is
 *     already `delivered` is ahead of a queue that has not caught up and wins over queued/typing/
 *     cancelled/failed. Otherwise the ledger's own fate stands.
 *   * A queue message with no ledger row yet — waiting for a draft, a question, its turn — becomes a row of
 *     its own, so it is a bubble in the right place the moment it is accepted.
 *
 * Pure and total: the same two lists always give the same rows, and an empty queue returns the ledger as is.
 */
export const joinQueue = (
  records: readonly LedgerSendRecord[],
  queue: readonly QueuedMessage[],
): readonly LedgerSendRecord[] => {
  if (queue.length === 0) return records;
  const byId = new Map(queue.map(message => [message.id, message] as const));
  const seen = new Set<string>();
  const joined = records.map((row): LedgerSendRecord => {
    const message = byId.get(row.sendId);
    if (message === undefined) return row;
    seen.add(row.sendId);
    return joinedRow(row, message);
  });
  for (const message of queue) if (!seen.has(message.id)) joined.push(synthesize(message));
  return joined;
};

/**
 * What a row's queue state is once the ledger has had its say: a delivered ledger fate means the agent has
 * it, whatever the queue has caught up to. `undefined` for a row the queue never saw.
 */
export const effectiveQueueState = (record: LedgerSendRecord): QueuedMessage['state'] | undefined => {
  const state = record.queue?.state;
  if (state === undefined) return undefined;
  if (record.fate === 'delivered' && !isQueueArrived(state)) return 'delivered';
  return state;
};

/** Words for why a queued message has not gone yet, in a person's terms. */
export const WAIT_REASON_COPY: Readonly<Record<NonNullable<QueuedMessage['waitReason']>, string>> = {
  launching: 'it is still starting',
  busy: 'the ferret is busy',
  question: 'a question is open',
  dialog: 'a dialog is on its screen',
  draft: 'its box holds a draft',
  unreadable: 'its screen can’t be read',
  stopped: 'it is not running',
};

type QueueEdit = (record: { readonly sendId: string }, text: string) => Promise<boolean>;
type QueueCancel = (record: { readonly sendId: string }) => Promise<boolean>;

/** What the app can do to a queued message. Reached through a React context, never through page props. */
export interface QueueActions {
  readonly edit: QueueEdit;
  readonly cancel: QueueCancel;
}

const messagePath = (sessionId: string, id: string): string => `${queuePath(sessionId)}/${encodeURIComponent(id)}`;

/** The daemon's sentence for a refused edit or cancel: 409 once typed, 404 for a message it does not know. */
export class QueueActionError extends Error {
  override readonly name = 'QueueActionError';
  constructor(
    message: string,
    readonly kind: 'typed' | 'unknown' | 'other',
  ) {
    super(message);
  }
}

const TYPED_COPY = 'It was just typed into the agent, so it can no longer be changed or taken back.';
const UNKNOWN_COPY = 'The queue no longer has this message.';

const refused = (reason: unknown): never => {
  const status = statusOf(reason);
  if (status === 409) throw new QueueActionError(TYPED_COPY, 'typed');
  if (status === 404) throw new QueueActionError(UNKNOWN_COPY, 'unknown');
  throw reason;
};

/**
 * Edit and cancel for one session, then a refresh so the bubble moves at once. A refusal (409 typed, 404
 * unknown) still refreshes — the row is stale — and reaches the caller as a {@link QueueActionError}.
 */
export const queueActions = (
  client: Pick<IFyApiClient, 'request'> | null,
  sessionId: string,
  refresh: () => void,
): QueueActions => {
  const run = async (id: string, init: RequestInit): Promise<boolean> => {
    if (client === null) return false;
    try {
      await client.request(messagePath(sessionId, id), z.unknown(), init);
    } catch (reason) {
      refresh();
      return refused(reason);
    }
    refresh();
    return true;
  };
  return {
    edit: (record, text) =>
      run(record.sendId, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(QueueEditRequestSchema.parse({ text })),
      }),
    cancel: record => run(record.sendId, { method: 'DELETE' }),
  };
};
