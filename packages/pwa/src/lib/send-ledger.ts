// THE SEND LEDGER, BROWSER SIDE.
//
// One job: turn the daemon's send list plus its live `control.send_*` events
// into the rows a reader sees for messages that are not (yet) visible as
// transcript records — and do it without ever inventing a delivery.
//
// The browser never decides delivery. An earlier design inferred it from the
// turn counter, and a corpus audit of 1,826 transcripts killed that outright:
// the harness drains a queued message mid-turn in most cases, and drains are
// batched, so a turn advance is not evidence about any particular send. The
// daemon's ledger owns fate; this module renders that decision and performs no
// content matching of its own to establish it.
//
// WHY THIS PARSES BY HAND INSTEAD OF USING `SendRecordSchema`.
//
// `@ferretry/protocol` describes the row a current daemon emits, and rejecting
// a row whole is right for a daemon request. It is wrong for this read model: a
// daemon NEWER than this public bundle may widen `fate`, `path`, or the
// evidence enums at any time, and a static site cannot be redeployed in step
// with every daemon a reader pairs. Failing closed there would blank the
// ledger — the reader would see no trace of a message that exists. So unknown
// values degrade field by field, and the row survives.

import type {
  IFyApiClient,
  SendCancelEffect,
  SendFate,
  SendPath,
  SendSenderKind,
  SendUnaccountedReason,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { OutboxView, QueueView } from './send-queue.ts';

/**
 * Slack when joining a durable row to the optimistic row that caused it. The
 * daemon stamps `acceptedAt` from its own clock, which can sit slightly behind
 * the browser's.
 */
export const RECORD_CLOCK_SLACK_MS = 5_000;

/**
 * The citation a daemon supplies for a delivered send. Only `key` is required:
 * every other field is dropped when this build does not recognise it, because
 * an unreadable tier must not make an otherwise usable citation unusable.
 */
export interface LedgerSendEvidence {
  readonly key: string;
  readonly kind?: 'chat.user' | 'queued_command' | 'response_item';
  readonly tier?: 'queue-file-id' | 'turn-instruction' | 'exact-text' | 'merged-text';
  readonly harness?: 'claude' | 'codex';
  readonly proof?: 'normal-user-record' | 'native-queue-drain';
  readonly observedAt?: string;
  readonly originatedAt?: string;
  readonly matchedTurn?: number;
  readonly shapeVersion?: number;
}

/**
 * The browser's tolerant read model of a protocol send row. Everything the
 * daemon may legitimately omit or widen is optional here; `payloadFile` is
 * absent by design, because private payload paths do not cross the API
 * boundary in this protocol.
 */
export interface LedgerSendRecord {
  readonly sendId: string;
  readonly acceptedAt: string;
  readonly message: string;
  readonly attachmentIds: readonly string[];
  readonly fate: SendFate;
  readonly v?: number;
  readonly acceptedTurn?: number;
  readonly path?: SendPath;
  readonly matchText?: string;
  readonly turn?: number;
  readonly from?: string;
  readonly fromName?: string;
  readonly senderKind?: SendSenderKind;
  /** Who sent it, as data, for a send that never went through the queue (an interactive ferret's board nudge). */
  readonly by?: LedgerSender;
  readonly replyExpected?: true;
  readonly held?: true;
  readonly withdrawn?: true;
  readonly fateAt?: string;
  readonly unaccountedReason?: SendUnaccountedReason;
  readonly opportunityAt?: string;
  readonly unaccountedDeadline?: string;
  readonly hardDeadline?: string;
  readonly timeoutFrozenAt?: string;
  readonly evidence?: LedgerSendEvidence;
  readonly queuedAt?: string;
  /** 1 for the first transport; each re-attempt under the same id adds one. */
  readonly attempt?: number;
  readonly attemptAt?: string;
  /** True only on a send the daemon PROVED never arrived, so retrying it cannot duplicate it. */
  readonly retryable?: true;
  /** The message is sitting typed in the agent’s composer and was never submitted. */
  readonly typedNotSent?: true;
  /** What a `cancelled` fate did to the agent’s screen. */
  readonly cancelEffect?: SendCancelEffect;
  /**
   * THIS BROWSER COULD NOT READ THE LEDGER, so the fate above is the last one it saw rather than the
   * daemon's current word. Never on the wire: {@link markLedgerUnread} sets it on open rows only.
   */
  readonly unread?: LedgerUnread;
  /** Where this device's outbox has this message, while it has not reached the machine's queue (`send-queue.ts`). */
  readonly outbox?: OutboxView;
  /** Where the durable queue has this message (`send-queue.ts`); absent for a message the queue never held. */
  readonly queue?: QueueView;
}

/** Since when the ledger could not be read, and why, in the failure's own words. */
export interface LedgerUnread {
  readonly since: string;
  readonly reason: string;
}

/**
 * How long the ledger may go unread before an open row stops claiming to know where its message is.
 * A few polls' worth, so one dropped read during a reconnect does not flicker every row.
 */
export const LEDGER_UNREAD_GRACE_MS = 15_000;

/**
 * Says, on every row still open, that its fate is no longer being read.
 *
 * WHY THIS EXISTS. A phone on the relay showed a message as "Sending" for as long as anyone looked,
 * because the only thing that moves a row is a successful read of `/sends`, and every way that read
 * could fail — a carrier that stopped answering, a refusal, a page this bundle could not parse — was
 * silently dropped ("the sends are an overlay"). The row then kept the last fate it had seen, and
 * "the daemon has it and is checking" stayed on screen long after the daemon had settled it. A
 * settled row is left alone: delivered, cancelled, unconfirmed and failed are already final words.
 */
export const markLedgerUnread = (
  records: readonly LedgerSendRecord[],
  problem: { readonly reason: string; readonly lastReadAt: number; readonly nowMs: number },
): LedgerSendRecord[] => {
  if (problem.nowMs - problem.lastReadAt < LEDGER_UNREAD_GRACE_MS) return [...records];
  const unread: LedgerUnread = { since: new Date(problem.lastReadAt).toISOString(), reason: problem.reason };
  return records.map(record =>
    record.fate === 'accepted' || record.fate === 'queued' ? { ...record, unread } : record,
  );
};

/**
 * A send the ledger gave up on only because its session ended. The ledger could not know whether the agent
 * had it first, so this is NOT "not delivered": it reads as unconfirmed and offers no one-tap retry.
 */
export const isSessionEndedTimeout = (record: LedgerSendRecord): boolean =>
  record.fate === 'timed_out' && record.unaccountedReason === 'session_ended';

/** How a page holds its rows: a value, or an update of the rows it already has (React's `setState`). */
export type LedgerRowsSetter = (
  next: readonly LedgerSendRecord[] | ((rows: readonly LedgerSendRecord[]) => readonly LedgerSendRecord[]),
) => void;

/**
 * One workspace's ledger feed: every read's rows, and every failed read said on the rows it left.
 * "Since" counts from the feed's own start, so a workspace that never managed a read says so after
 * the grace rather than inheriting another workspace's last success.
 */
export const ledgerFeed = (
  setRows: LedgerRowsSetter,
  now: () => number = Date.now,
): {
  readonly onSends: (rows: readonly LedgerSendRecord[]) => void;
  readonly onSendsFailed: (reason: string) => void;
} => {
  let lastReadAt = now();
  return {
    onSends: rows => {
      lastReadAt = now();
      setRows(rows);
    },
    onSendsFailed: reason => setRows(rows => markLedgerUnread(rows, { reason, lastReadAt, nowMs: now() })),
  };
};

/**
 * How long one ledger read may take. Shorter than the client's default, because every poll waits for
 * it: a read that hangs holds the transcript and the ledger still with it.
 */
export const LEDGER_READ_TIMEOUT_MS = 20_000;

/**
 * One read of a session's ledger, as the rows the daemon sent: parsed by THIS app rather than the typed client.
 *
 * `IFyApiClient.sends` validates the page with `SendRecordSchema`, whose enums are closed, so a row
 * carrying one value this bundle has never heard of — a daemon a release ahead, a new evidence tier —
 * rejected the WHOLE page, and the tolerant parser below never saw it. That is exactly the failure its
 * header says it exists to prevent: a reader on an older bundle watched a delivered message read
 * "Sending" forever. The request is the same route; only the reading changed.
 *
 * The rows come back UNPARSED, because the session cache keeps them as the daemon sent them — a row
 * this bundle cannot read may be one the next bundle can. `parseLedgerSendsResponse` reads them.
 */
export const readLedgerSends = async (
  api: Pick<IFyApiClient, 'request'>,
  sessionId: string,
): Promise<readonly unknown[]> =>
  ledgerRows(
    await api.request(`/v1/sessions/${encodeURIComponent(sessionId)}/sends`, z.unknown(), {}, LEDGER_READ_TIMEOUT_MS),
  );

/**
 * A row no deadline can retire: withdrawn, deliberately held, delivered, or taken back by a person.
 * None of them is a stale attempt, so none is ever re-badged unconfirmed or timed out of view.
 */
const isSettledForGood = (record: LedgerSendRecord): boolean =>
  record.withdrawn === true || record.held === true || record.fate === 'delivered' || record.fate === 'cancelled';

/**
 * Has the durable row outlived the daemon's final live-view deadline?
 *
 * This is presentation retirement only; the append-only ledger stays intact.
 * Missing or malformed deadlines stay VISIBLE: version skew must degrade
 * toward showing uncertainty, never toward silently hiding it. Delivered,
 * cancelled and deliberately-held rows are not stale attempts, so they never expire.
 */
export const hasLedgerHardExpired = (record: LedgerSendRecord, nowMs: number = Date.now()): boolean => {
  if (isSettledForGood(record)) return false;
  const deadline = Date.parse(record.hardDeadline ?? '');
  return Number.isFinite(deadline) && deadline <= nowMs;
};

/**
 * The daemon may not have run its timeout sweep at the exact deadline. Once
 * `unaccountedDeadline` passes, an accepted row belongs with the honest
 * unconfirmed rows instead of pretending something is still happening now.
 */
export const isLedgerUnconfirmed = (record: LedgerSendRecord, nowMs: number = Date.now()): boolean => {
  if (isSettledForGood(record)) return false;
  if (record.fate === 'unaccounted') return true;
  const deadline = Date.parse(record.unaccountedDeadline ?? '');
  return Number.isFinite(deadline) && deadline <= nowMs;
};

/**
 * The next instant at which this page's presentation can change without a
 * socket event: an accepted badge becomes unconfirmed, or an open row reaches
 * its hard live-view cap. One scheduled timeout instead of polling.
 */
export const nextLedgerViewDeadline = (
  records: readonly LedgerSendRecord[],
  nowMs: number = Date.now(),
): number | undefined => {
  let next = Number.POSITIVE_INFINITY;
  for (const record of records) {
    if (isSettledForGood(record)) continue;
    const candidates =
      record.fate === 'accepted' ? [record.unaccountedDeadline, record.hardDeadline] : [record.hardDeadline];
    for (const value of candidates) {
      const at = Date.parse(value ?? '');
      if (Number.isFinite(at) && at > nowMs && at < next) next = at;
    }
  }
  return Number.isFinite(next) ? next : undefined;
};

/**
 * Journal events meaning "the ledger changed, re-read it".
 *
 * Refresh is triggered by these rather than the row being rebuilt from them,
 * so what a reader sees is always something the daemon confirmed on disk.
 * `send_withdrawn` is included because a synchronous injection failure
 * tombstones the record: the row must retract, and a refresh is what retracts
 * it. Every fate the daemon's tracker proves — queued, delivered, timed out,
 * unconfirmed — and every re-attempt or release journals one of these, so a
 * reader sees a send move the moment the daemon has proof.
 */
const SEND_LEDGER_EVENTS: ReadonlySet<string> = new Set([
  'control.send_accepted',
  'control.send_queued',
  'control.send_delivered',
  'control.send_unaccounted',
  'control.send_timed_out',
  'control.send_retried',
  'control.send_released',
  'control.send_typed_not_sent',
  'control.send_cancelled',
  'control.send_submitted',
  'control.send_withdrawn',
]);

/**
 * Takes the envelope's `type` alone rather than a parsed `FyEvent`: this is a
 * routing question asked of every frame on the socket, and a full parse is the
 * subscriber's job once the frame is known to matter.
 */
export const isSendLedgerEvent = (event: { readonly type: string }): boolean => SEND_LEDGER_EVENTS.has(event.type);

const FATES: ReadonlySet<string> = new Set<SendFate>([
  'accepted',
  'queued',
  'delivered',
  'unaccounted',
  'timed_out',
  'cancelled',
]);
const PATHS: ReadonlySet<string> = new Set<SendPath>([
  'direct',
  'turn-file',
  'native-inline',
  'native-file',
  'revive',
  'revive-queue',
]);
const REASONS: ReadonlySet<string> = new Set<SendUnaccountedReason>([
  'timeout',
  'session_ended',
  'composer_discarded',
  'transcript_unreadable',
  'transcript_unbound',
  'pane_unreadable',
  'blocked_by_prompt',
  'revive_unconfirmed',
  'landing_unconfirmed',
  'not_delivered',
]);
const CANCEL_EFFECTS: ReadonlySet<string> = new Set<SendCancelEffect>([
  'cleared',
  'not_in_pane',
  'left_in_queue',
  'left_in_composer',
]);
const SENDERS: ReadonlySet<string> = new Set<SendSenderKind>(['human', 'agent', 'daemon']);

const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const attachmentIds = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((id): id is string => typeof id === 'string' && /^att_[a-f0-9]{64}$/iu.test(id))
    : [];

const literal = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

const parseEvidence = (value: unknown): LedgerSendEvidence | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const source = value as Record<string, unknown>;
  const key = str(source['key']);
  // Evidence without a key cannot be deduped or trusted as an anchor, so it is
  // dropped rather than half-kept. The fate stays whatever the daemon said:
  // this module refuses to carry an unusable citation, not to second-guess the
  // decision the citation was for.
  if (key === undefined) return undefined;
  return {
    key,
    ...optional('kind', literal(source['kind'], ['chat.user', 'queued_command', 'response_item'] as const)),
    ...optional(
      'tier',
      literal(source['tier'], ['queue-file-id', 'turn-instruction', 'exact-text', 'merged-text'] as const),
    ),
    ...optional('harness', literal(source['harness'], ['claude', 'codex'] as const)),
    ...optional('proof', literal(source['proof'], ['normal-user-record', 'native-queue-drain'] as const)),
    ...optional('observedAt', str(source['observedAt'])),
    ...optional('originatedAt', str(source['originatedAt'])),
    ...optional('matchedTurn', num(source['matchedTurn'])),
    ...optional('shapeVersion', num(source['shapeVersion'])),
  };
};

/** Spreads a field only when it is present, keeping `exactOptionalPropertyTypes` honest. */
const optional = <K extends string, V>(name: K, value: V | undefined): Partial<Record<K, V>> =>
  value === undefined ? {} : ({ [name]: value } as Record<K, V>);

/**
 * Parses one wire row.
 *
 * Returns null only when the row has no usable IDENTITY (`sendId`/`acceptedAt`)
 * — a row that cannot be keyed or placed is worse than absent, because it would
 * merge unpredictably.
 *
 * THE FATE DEFAULT IS THE LOAD-BEARING LINE. A daemon newer than this bundle
 * may report a state this build has never heard of. Reading it as `accepted`
 * keeps the message visible and claims nothing; reading it as `delivered` would
 * silently assert that an unverified message reached the agent.
 */
/** Who a send is from, as the daemon says it: the part of this row the sender chip and the system rows read. */
export interface LedgerSender {
  readonly kind: 'owner' | 'ferret' | 'ferretry';
  readonly name?: string;
  readonly feature?: string;
}

const parseLedgerSender = (raw: unknown): LedgerSender | undefined => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  const kind = literal(row['kind'], ['owner', 'ferret', 'ferretry'] as const);
  if (kind === undefined) return undefined;
  return { kind, ...optional('name', str(row['name'])), ...optional('feature', str(row['feature'])) };
};

export const parseLedgerSendRecord = (raw: unknown): LedgerSendRecord | null => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const sendId = str(row['sendId']);
  const acceptedAt = str(row['acceptedAt']);
  if (sendId === undefined || acceptedAt === undefined) return null;
  return {
    sendId,
    acceptedAt,
    message: typeof row['message'] === 'string' ? row['message'] : '',
    attachmentIds: attachmentIds(row['attachmentIds']),
    fate: (literal(row['fate'], [...FATES] as SendFate[]) ?? 'accepted') as SendFate,
    ...optional('v', num(row['v'])),
    ...optional('acceptedTurn', num(row['acceptedTurn'])),
    ...optional('path', literal(row['path'], [...PATHS] as SendPath[])),
    ...optional('matchText', str(row['matchText'])),
    ...optional('turn', num(row['turn'])),
    ...optional('from', str(row['from'])),
    ...optional('fromName', str(row['fromName'])),
    ...optional('senderKind', literal(row['senderKind'], [...SENDERS] as SendSenderKind[])),
    ...optional('by', parseLedgerSender(row['by'])),
    ...(row['replyExpected'] === true ? { replyExpected: true as const } : {}),
    ...(row['held'] === true ? { held: true as const } : {}),
    ...(row['withdrawn'] === true ? { withdrawn: true as const } : {}),
    ...optional('fateAt', str(row['fateAt'])),
    ...optional('unaccountedReason', literal(row['unaccountedReason'], [...REASONS] as SendUnaccountedReason[])),
    ...optional('opportunityAt', str(row['opportunityAt'])),
    ...optional('unaccountedDeadline', str(row['unaccountedDeadline'])),
    ...optional('hardDeadline', str(row['hardDeadline'])),
    ...optional('timeoutFrozenAt', str(row['timeoutFrozenAt'])),
    ...optional('evidence', parseEvidence(row['evidence'])),
    ...optional('queuedAt', str(row['queuedAt'])),
    ...optional('attempt', num(row['attempt'])),
    ...optional('attemptAt', str(row['attemptAt'])),
    ...(row['retryable'] === true ? { retryable: true as const } : {}),
    ...(row['typedNotSent'] === true ? { typedNotSent: true as const } : {}),
    ...optional('cancelEffect', literal(row['cancelEffect'], [...CANCEL_EFFECTS] as SendCancelEffect[])),
  };
};

/** The rows of the endpoint envelope, or of a bare array (an older or hand-rolled daemon). */
const ledgerRows = (raw: unknown): readonly unknown[] =>
  Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { sends?: unknown }).sends)
      ? (raw as { sends: unknown[] }).sends
      : [];

/**
 * Parses the endpoint envelope. Tolerates a bare array (an older or hand-rolled
 * daemon) and drops unusable rows individually, so one malformed row cannot
 * blank the whole ledger.
 */
export const parseLedgerSendsResponse = (raw: unknown): LedgerSendRecord[] => {
  const parsed: LedgerSendRecord[] = [];
  for (const row of ledgerRows(raw)) {
    const record = parseLedgerSendRecord(row);
    if (record !== null) parsed.push(record);
  }
  return parsed;
};

/**
 * Fate ordering. Within one delivery attempt a send only moves up this ladder:
 * accepted → queued (the harness holds it) → unaccounted or timed out (the
 * daemon settled it unproven) → cancelled (a person took it back) → delivered (proof arrived,
 * which outranks a cancel: a message the agent read was read). Nothing legitimately
 * moves down within an attempt; a RE-attempt starts the ladder again.
 */
const FATE_RANK: Record<SendFate, number> = {
  accepted: 0,
  queued: 1,
  unaccounted: 2,
  timed_out: 2,
  cancelled: 3,
  delivered: 4,
};

/**
 * Should `incoming` replace `existing` for the same sendId?
 *
 * A RETRY IS A NEW ATTEMPT, NOT A REGRESSION. Retrying reuses the original
 * request id — the point of an idempotency key — so a retried send arrives
 * under the same sendId with a newer `acceptedAt`. That separates "the daemon
 * accepted this again" from "a stale response is trying to un-say what we
 * already know", which is why the attempt clock is checked before the ladder.
 *
 * Within one attempt the ladder is enforced, so an out-of-order older fetch can
 * neither flip a confirmed message back to unconfirmed nor restore queued over
 * an honest unconfirmed. Equal rank still replaces, so a fresher snapshot of
 * the same fate delivers its updated deadlines.
 */
const supersedes = (incoming: LedgerSendRecord, existing: LedgerSendRecord): boolean => {
  const incomingAt = Date.parse(incoming.acceptedAt);
  const existingAt = Date.parse(existing.acceptedAt);
  if (Number.isFinite(incomingAt) && Number.isFinite(existingAt) && incomingAt !== existingAt)
    return incomingAt > existingAt;
  // The same send typed again under its own id is a NEWER attempt: it may move
  // a settled row back to sending, which is the truth about a re-attempt.
  const incomingAttempt = incoming.attempt ?? 1;
  const existingAttempt = existing.attempt ?? 1;
  if (incomingAttempt !== existingAttempt) return incomingAttempt > existingAttempt;
  // Same attempt. A tombstone is sticky: the caller was told synchronously and
  // still holds the message, so only a genuinely newer attempt may undo it.
  if (existing.withdrawn === true && incoming.withdrawn !== true) return false;
  return FATE_RANK[incoming.fate] >= FATE_RANK[existing.fate];
};

/**
 * Folds snapshots by sendId and returns them newest-first.
 *
 * The ledger is a log of full-row snapshots, so folding is the whole merge, and
 * it is NOT last-wins: the initial list and live-event refreshes are separate
 * responses that can land out of order, and last-wins would let a snapshot
 * taken before a transition overwrite the transition. `supersedes` makes the
 * fold order-independent instead.
 *
 * TOMBSTONES MUST REACH THIS FUNCTION — DO NOT FILTER THEM AT PARSE TIME.
 * The endpoint deliberately includes withdrawn rows: that is the RETRACTION
 * mechanism. After `control.send_withdrawn` the refresh re-reads the endpoint,
 * the tombstone arrives, and folding it over the previously fetched accepted
 * row is the only thing that removes that row from the UI. Strip tombstones
 * upstream as a "cleanup" and a withdrawn send keeps its accepted chip forever,
 * because nothing else ever contradicts it.
 *
 * So the drop happens HERE, on the folded output, after the tombstone has had
 * its chance to supersede. An audit surface that wants to SHOW attempted-and-
 * refused sends must read `parseLedgerSendsResponse` output directly.
 */
export const foldLedgerSendRecords = (...groups: readonly (readonly LedgerSendRecord[])[]): LedgerSendRecord[] => {
  const byId = new Map<string, LedgerSendRecord>();
  for (const group of groups) {
    for (const record of group) {
      const existing = byId.get(record.sendId);
      if (existing !== undefined && !supersedes(record, existing)) continue;
      byId.set(record.sendId, record);
    }
  }
  return [...byId.values()]
    .filter(record => record.withdrawn !== true)
    .sort((a, b) => (Date.parse(b.acceptedAt) || 0) - (Date.parse(a.acceptedAt) || 0));
};
