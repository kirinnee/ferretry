// THE DURABLE QUEUE, BROWSER SIDE.
//
// A message to a ferret is written to the ferret's queue before anything is typed (docs/message-delivery.md,
// "The durable queue"). The queue owns the first ticks — ✓ queued, then typing — and the send ledger owns the
// rest once the message is handed over, under the SAME id. This module reads the queue and JOINS it to the
// ledger rows, so one message is one bubble for its whole life.

import { DaemonCallError } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { FerretQueueSchema, type QueuedMessage, QueueEditRequestSchema } from '../../contract/index.ts';
import type { LedgerSendRecord } from '../chat/send-ledger.ts';
import { type OutboxEntry, type SendOutbox, WAITING_REASON } from '../composer/send-outbox.ts';

/** The half's client, as far as the queue uses it. */
type QueueClient = Pick<PluginClient, 'call'>;

interface QueueSender {
  readonly kind: 'owner' | 'ferret' | 'ferretry';
  readonly name?: string;
  readonly feature?: string;
  readonly sections?: readonly string[];
}

const senderOf = (message: QueuedMessage): QueueSender | undefined => {
  const by = (message as { readonly by?: QueueSender }).by;
  return by !== undefined && (by.kind === 'owner' || by.kind === 'ferret' || by.kind === 'ferretry') ? by : undefined;
};

/** What the queue says about one message — the part of a `QueuedMessage` a bubble draws. */
export interface QueueView {
  readonly state: QueuedMessage['state'];
  readonly stateAt: string;
  readonly revision: number;
  readonly waitReason?: NonNullable<QueuedMessage['waitReason']>;
  readonly failure?: string;
  /** Who sent it, when the daemon says (`QueuedMessage.by`). */
  readonly by?: QueueSender;
  /**
   * The id of the send this message travelled inside, when the daemon combined it with others into ONE
   * turn: the oldest member's. Only set on a message that is NOT that send itself.
   */
  readonly deliveredAs?: string;
}

/** Which page of the queue a read asks for: none is the daemon's window (the newest page and every open message). */
export interface QueuePageRequest {
  /** The cursor a previous page named, to read the next older page. */
  readonly before?: string;
  readonly limit?: number;
}

/** One page of a ferret's queue, oldest first, and where the older history starts (`null`: nothing older). */
export interface QueuePageRead {
  readonly messages: readonly QueuedMessage[];
  readonly nextCursor: string | null;
}

const pageQuery = (request: QueuePageRequest): Record<string, string> => ({
  ...(request.before === undefined ? {} : { before: request.before }),
  ...(request.limit === undefined ? {} : { limit: String(request.limit) }),
});

const statusOf = (reason: unknown): number | undefined =>
  reason instanceof DaemonCallError ? reason.status : undefined;

/** One page of a ferret's queue, parsed with the contract's schema: `GET /v1/ferrets/:ferretId/queue`. */
export const readFerretQueuePage = async (
  client: QueueClient,
  ferretId: string,
  request: QueuePageRequest = {},
): Promise<QueuePageRead> => {
  const page = FerretQueueSchema.parse(
    await client.call('GET /v1/ferrets/:ferretId/queue', { params: { ferretId }, query: pageQuery(request) }),
  );
  return { messages: page.messages, nextCursor: page.nextCursor ?? null };
};

/**
 * The queue the chat joins to its ledger rows: the daemon's window (the newest page and every open message),
 * which is the same window the ledger read answers. A bubble whose queue row falls outside it is drawn from
 * its ledger row alone.
 */
export const readFerretQueue = async (client: QueueClient, ferretId: string): Promise<readonly QueuedMessage[]> =>
  (await readFerretQueuePage(client, ferretId)).messages;

/** The queue message states that mean the agent has the message. */
const isQueueArrived = (state: QueuedMessage['state']): boolean => state === 'delivered' || state === 'read';

const viewOf = (message: QueuedMessage): QueueView => ({
  state: message.state,
  stateAt: message.stateAt,
  revision: message.revision,
  ...(message.waitReason === undefined ? {} : { waitReason: message.waitReason }),
  ...(message.failure === undefined ? {} : { failure: message.failure }),
  ...(senderOf(message) === undefined ? {} : { by: senderOf(message) }),
  ...(message.deliveredAs === undefined || message.deliveredAs === message.id
    ? {}
    : { deliveredAs: message.deliveredAs }),
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
    case 'unconfirmed':
      return 'unaccounted';
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
  if (state === 'cancelled') return 'cancelled';
  // Failed in the queue means nothing PROVED the message arrived — not that it didn't. Only a ledger that
  // proved it absent (or no ledger row at all, in `synthesize`) is red; anything else may have landed.
  if (state === 'failed') return row.fate === 'timed_out' ? 'timed_out' : 'unaccounted';
  // Typed, and nothing proves it arrived, though it may have: never "sending" again, never red.
  if (state === 'unconfirmed') return 'unaccounted';
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
 *   * SEVERAL MESSAGES DELIVERED AS ONE TURN have ONE ledger row, under the oldest member's id, whose
 *     message is the combined text. Only that member joins it; every other member (`deliveredAs`) keeps the
 *     row it already has from the queue — its own words, its own ticks, its own sender — so no message is
 *     swallowed by the combined text and none is drawn twice. The combined row is read as its first
 *     message (`peerFrom`), which is the lead member's own text; where the rest sit in the conversation is
 *     `placeLedgerRows`'s business.
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
  /**
   * Called while a queued message's menu or editor is open, so the chat reads the queue on every poll tick for as long
   * as it is (a bare tick does not); returns the release. Absent: nothing to tell.
   */
  readonly watch?: () => () => void;
}

/** The sentence for a refused edit or cancel: 409 once typed, 404 for a message it does not know. */
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
 * Edit and cancel for one ferret, then a refresh so the bubble moves at once. A refusal (409 typed, 404
 * unknown) still refreshes — the row is stale — and reaches the caller as a {@link QueueActionError}.
 */
export const queueActions = (
  client: QueueClient | null,
  ferretId: string,
  refresh: () => void,
  outbox?: Pick<SendOutbox, 'edit' | 'cancel'>,
  watch?: () => () => void,
): QueueActions => {
  const run = async (
    id: string,
    change: { readonly route: 'PATCH'; readonly text: string } | { readonly route: 'DELETE' },
  ): Promise<boolean> => {
    if (client === null) return false;
    const params = { ferretId, messageId: id };
    try {
      if (change.route === 'PATCH')
        await client.call('PATCH /v1/ferrets/:ferretId/queue/:messageId', {
          params,
          body: QueueEditRequestSchema.parse({ text: change.text }),
        });
      else await client.call('DELETE /v1/ferrets/:ferretId/queue/:messageId', { params });
    } catch (reason) {
      refresh();
      return refused(reason);
    }
    refresh();
    return true;
  };
  return {
    ...(watch === undefined ? {} : { watch }),
    edit: async (record, text) => {
      if ((await outbox?.edit(record.sendId, text)) === 'edited') {
        refresh();
        return true;
      }
      return await run(record.sendId, { route: 'PATCH', text });
    },
    cancel: async record => {
      if ((await outbox?.cancel(record.sendId)) === 'cancelled') {
        refresh();
        return true;
      }
      return await run(record.sendId, { route: 'DELETE' });
    },
  };
};

/** What this device's outbox says about a message that has not reached the machine's queue yet. */
export interface OutboxView {
  /** Why it still waits, in plain words ("waiting for connection"), or why the machine refused it. */
  readonly reason: string;
  /** A machine answered "no": it will not leave on its own, so the person must edit or cancel it. */
  readonly refused?: true;
  /** Its place among this ferret's entries that are still on the device (1-based), and how many there are. */
  readonly position: number;
  readonly of: number;
  /** Names of the files it carries that are not uploaded yet: they go up before the send. */
  readonly files?: readonly string[];
}

/**
 * Adds the messages still on this device to the rows a ferret shows.
 *
 * An entry the machine already knows (a row with its id) is dropped here: the outbox forgets an entry only
 * after the machine answered, so for a moment both exist, and the machine's word is the later tick. An
 * entry with no row becomes one, wearing a `queued` queue view so the bubble offers Edit and Cancel exactly
 * as it does for a message on the machine's queue — `outbox` is what makes its tick the first one.
 */
export const joinOutbox = (
  rows: readonly LedgerSendRecord[],
  entries: readonly OutboxEntry[],
): readonly LedgerSendRecord[] => {
  const known = new Set(rows.map(row => row.sendId));
  const waiting = entries.filter(entry => !known.has(entry.id));
  if (waiting.length === 0) return rows;
  return [
    ...rows,
    ...waiting.map(
      (entry, index): LedgerSendRecord => ({
        sendId: entry.id,
        acceptedAt: entry.createdAt,
        message: entry.message,
        attachmentIds: [...entry.attachmentIds],
        fate: 'accepted',
        senderKind: 'human',
        queue: { state: 'queued', stateAt: entry.createdAt, revision: 0 },
        outbox: {
          reason: entry.reason ?? WAITING_REASON,
          ...(entry.refused === true ? { refused: true as const } : {}),
          position: index + 1,
          of: waiting.length,
          ...(entry.files.length === 0 ? {} : { files: entry.files.map(file => file.name) }),
        },
      }),
    ),
  ];
};

/** What taking one message back out of a ferret's queue came to: gone, or already in the agent's hands. */
export type QueueWithdrawal = 'withdrawn' | 'taken';

/**
 * Takes a message the owner just sent back out of the queue, the same way the chat cancels a waiting message:
 * this device's outbox first, then the machine's queue route. The machine saying it was already typed (409) or no
 * longer knows it (404) means the agent has it — `taken`, not a failure. Any other refusal throws.
 */
export const withdrawQueued = async (
  client: QueueClient | null,
  ferretId: string,
  sendId: string,
  outbox?: Pick<SendOutbox, 'edit' | 'cancel'>,
): Promise<QueueWithdrawal> => {
  try {
    const done = await queueActions(client, ferretId, () => undefined, outbox).cancel({ sendId });
    if (!done) throw new Error('That machine is not reachable from this browser.');
    return 'withdrawn';
  } catch (reason) {
    if (reason instanceof QueueActionError && reason.kind !== 'other') return 'taken';
    throw reason;
  }
};

/**
 * Undo of an Inbox reply: finds the machine the reply went to among the paired ones and withdraws the message there.
 * A machine that is no longer paired throws, so the page can say the card could not be put back honestly.
 */
export const withdrawReplyVia =
  (
    /** The half's client for a paired daemon, or `undefined` when that daemon is no longer paired. */
    clientOf: (daemon: string) => QueueClient | undefined,
    outbox: Pick<SendOutbox, 'edit' | 'cancel'>,
  ) =>
  async (card: { readonly daemon: string; readonly ferret: string }, sendId: string): Promise<QueueWithdrawal> => {
    const client = clientOf(card.daemon);
    if (client === undefined) throw new Error('That machine is no longer paired with this browser.');
    return await withdrawQueued(client, card.ferret, sendId, outbox);
  };

/**
 * WHAT THE QUEUE PAGE HOLDS OF ONE FERRET'S QUEUE: the daemon's window, plus any older pages the person asked for.
 *
 * `cursor` is where the next older page starts (`null`: the oldest message is already here) and `older` is
 * whether the person has asked for any. `walk` numbers the walk the cursor belongs to: it moves up whenever the walk
 * restarts from the window, and an older page read for one walk is never merged into another
 * ({@link extendQueueHistory}). The daemon never removes a message, so a poll that re-reads the window must not make
 * what the person already scrolled to vanish: {@link refreshQueueHistory} keeps it.
 */
export interface QueueHistory {
  readonly messages: readonly QueuedMessage[];
  readonly cursor: string | null;
  readonly older: boolean;
  readonly walk: number;
}

/** The window the daemon answered, nothing older asked for yet. */
export const startQueueHistory = (page: QueuePageRead): QueueHistory => ({
  messages: page.messages,
  cursor: page.nextCursor,
  older: false,
  walk: 0,
});

/** A message that can still move: the daemon always carries these on the window, wherever they sit. */
const isOpenState = (message: QueuedMessage): boolean =>
  message.state === 'queued' || message.state === 'typing' || message.state === 'unconfirmed';

/**
 * How far along its life a state is. A message only moves forward (a refused typing aside), so of two reads that
 * cannot be told apart by a version or an instant, the one further along is the later look.
 */
const PROGRESS: Readonly<Record<QueuedMessage['state'], number>> = {
  queued: 0,
  typing: 1,
  unconfirmed: 2,
  delivered: 3,
  read: 4,
  cancelled: 4,
  failed: 4,
};

/**
 * The fresher of one message as held and as just read, never a regression.
 *
 * The daemon stamps every message with a `version` that only grows (the position in its log of the message's latest
 * change), so with one on both the higher wins and an equal one is the same fact. Without one (the field is optional on the
 * wire) the later revision (an edit) wins, then the later `stateAt` (a move), and on a tie the one further along — a clock
 * tick is not a mutation, so two moves can share an instant and the later read is not always the later fact. Equally
 * far along, the incoming read is the newer look at the same state. A message repeated across pages is thereby held
 * once, in the newest state either read saw.
 */
const fresherMessage = (held: QueuedMessage, incoming: QueuedMessage): QueuedMessage => {
  if (held.version !== undefined && incoming.version !== undefined)
    return incoming.version > held.version ? incoming : held;
  if (incoming.revision !== held.revision) return incoming.revision > held.revision ? incoming : held;
  const later = Date.parse(incoming.stateAt) - Date.parse(held.stateAt);
  if (later !== 0) return later > 0 ? incoming : held;
  return PROGRESS[incoming.state] >= PROGRESS[held.state] ? incoming : held;
};

const byAgeThenId = (left: QueuedMessage, right: QueuedMessage): number =>
  Date.parse(left.enqueuedAt) - Date.parse(right.enqueuedAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** The messages of two reads as one set by id, the fresher of a repeated id kept, oldest first. */
const mergeMessages = (
  held: readonly QueuedMessage[],
  incoming: readonly QueuedMessage[],
): readonly QueuedMessage[] => {
  const merged = new Map(held.map(message => [message.id, message]));
  for (const message of incoming) {
    const have = merged.get(message.id);
    merged.set(message.id, have === undefined ? message : fresherMessage(have, message));
  }
  return [...merged.values()].sort(byAgeThenId);
};

/**
 * A fresh read of the window applied over what is held. Until the person asks for older messages it IS the
 * window. After, every message already shown stays (a new arrival pushes the window's edge up by one, and
 * the message that fell off it is in no older page this person has not already read) and the fresher read wins
 * for every id it carries.
 *
 * One thing cannot be kept as it is: a message held as still moving that the window no longer carries has finished
 * since, and the daemon's walk leaves it out of every older page (it was open when the walk began), so its new state is
 * unknown and would never come. It is let go and the WALK restarts from the window's edge — a new walk number, so no
 * older page still in the air for the old one is merged — while every other message stays on screen; the restarted walk
 * meets the finished one again, in its new state, where it belongs.
 */
export const refreshQueueHistory = (held: QueueHistory | undefined, fresh: QueuePageRead): QueueHistory => {
  if (held === undefined || !held.older) return { ...startQueueHistory(fresh), walk: held?.walk ?? 0 };
  const inWindow = new Set(fresh.messages.map(message => message.id));
  const gone = held.messages.filter(message => !inWindow.has(message.id) && isOpenState(message));
  if (gone.length === 0)
    return {
      messages: mergeMessages(held.messages, fresh.messages),
      cursor: held.cursor,
      older: true,
      walk: held.walk,
    };
  const letGo = new Set(gone.map(message => message.id));
  return {
    messages: mergeMessages(
      held.messages.filter(message => !letGo.has(message.id)),
      fresh.messages,
    ),
    cursor: fresh.nextCursor,
    older: true,
    walk: held.walk + 1,
  };
};

/** The place an older page was asked from: the walk and the cursor it was read at. */
export interface OlderRequest {
  readonly walk: number;
  readonly cursor: string;
}

/** The request for the page that follows `held`, or `undefined` when it reached the oldest message. */
export const olderRequest = (held: QueueHistory): OlderRequest | undefined =>
  held.cursor === null ? undefined : { walk: held.walk, cursor: held.cursor };

/**
 * An older page read from `from`, added to what is held; a message is held once, in the fresher state of the two
 * reads — a message that was open when the first page was cut and closed before this one arrives is the same bubble
 * in its newest state, never the stale one nor a second one.
 *
 * A page answers the walk and cursor it was asked from. Merged into a history whose walk has restarted or whose
 * cursor has moved on, it would hand that history a cursor that skips what the restart brought back, so it is not
 * merged: `held` comes back unchanged and the caller asks again from where the history stands now.
 */
export const extendQueueHistory = (held: QueueHistory, page: QueuePageRead, from?: OlderRequest): QueueHistory =>
  from !== undefined && (from.walk !== held.walk || from.cursor !== held.cursor)
    ? held
    : { messages: mergeMessages(held.messages, page.messages), cursor: page.nextCursor, older: true, walk: held.walk };
