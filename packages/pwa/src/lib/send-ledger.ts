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

import type { SendFate, SendPath, SendUnaccountedReason } from '@ferretry/protocol';

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
  readonly tier?: 'queue-file-id' | 'turn-instruction' | 'exact-text';
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
}

/**
 * Has the durable row outlived the daemon's final live-view deadline?
 *
 * This is presentation retirement only; the append-only ledger stays intact.
 * Missing or malformed deadlines stay VISIBLE: version skew must degrade
 * toward showing uncertainty, never toward silently hiding it. Delivered and
 * deliberately-held rows are not stale attempts, so they never expire.
 */
export const hasLedgerHardExpired = (record: LedgerSendRecord, nowMs: number = Date.now()): boolean => {
  if (record.withdrawn === true || record.held === true || record.fate === 'delivered') return false;
  const deadline = Date.parse(record.hardDeadline ?? '');
  return Number.isFinite(deadline) && deadline <= nowMs;
};

/**
 * The daemon may not have run its timeout sweep at the exact deadline. Once
 * `unaccountedDeadline` passes, an accepted row belongs with the honest
 * unconfirmed rows instead of pretending something is still happening now.
 */
export const isLedgerUnconfirmed = (record: LedgerSendRecord, nowMs: number = Date.now()): boolean => {
  if (record.withdrawn === true || record.held === true || record.fate === 'delivered') return false;
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
    if (record.withdrawn === true || record.held === true || record.fate === 'delivered') continue;
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
 * it. The legacy `send_queued`/`send_consumed` pair is deliberately absent —
 * treating those compat emissions as ledger signals would reintroduce a second,
 * disagreeing source.
 */
const SEND_LEDGER_EVENTS: ReadonlySet<string> = new Set([
  'control.send_accepted',
  'control.send_delivered',
  'control.send_unaccounted',
  'control.send_withdrawn',
]);

/**
 * Takes the envelope's `type` alone rather than a parsed `FyEvent`: this is a
 * routing question asked of every frame on the socket, and a full parse is the
 * subscriber's job once the frame is known to matter.
 */
export const isSendLedgerEvent = (event: { readonly type: string }): boolean => SEND_LEDGER_EVENTS.has(event.type);

const FATES: ReadonlySet<string> = new Set<SendFate>(['accepted', 'delivered', 'unaccounted']);
const PATHS: ReadonlySet<string> = new Set<SendPath>([
  'direct',
  'turn-file',
  'native-inline',
  'native-file',
  'revive',
  'revive-queue',
]);
const REASONS: ReadonlySet<string> = new Set<SendUnaccountedReason>(['timeout', 'session_ended', 'composer_discarded']);

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
    ...optional('tier', literal(source['tier'], ['queue-file-id', 'turn-instruction', 'exact-text'] as const)),
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
  };
};

/**
 * Parses the endpoint envelope. Tolerates a bare array (an older or hand-rolled
 * daemon) and drops unusable rows individually, so one malformed row cannot
 * blank the whole ledger.
 */
export const parseLedgerSendsResponse = (raw: unknown): LedgerSendRecord[] => {
  const rows = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray((raw as { sends?: unknown }).sends)
      ? (raw as { sends: unknown[] }).sends
      : [];
  const parsed: LedgerSendRecord[] = [];
  for (const row of rows) {
    const record = parseLedgerSendRecord(row);
    if (record !== null) parsed.push(record);
  }
  return parsed;
};

/**
 * Fate ordering. Within one delivery attempt a send only moves up this ladder:
 * accepted → unaccounted (we gave up looking) → delivered (proof arrived).
 * Nothing legitimately moves down.
 */
const FATE_RANK: Record<SendFate, number> = { accepted: 0, unaccounted: 1, delivered: 2 };

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
