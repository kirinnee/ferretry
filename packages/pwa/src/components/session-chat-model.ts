/**
 * THE NON-RENDERING HALF OF THE SESSION CHAT PAGE. Ported from the model,
 * predicate and projection code in kteam `ui/src/pages/SessionChatPage.tsx`.
 *
 * The chat page shows an OPTIMISTIC bubble the moment a message is sent, and
 * then has to recognise that same message when the daemon's own record of it
 * comes back — otherwise the reader sees their message twice, or watches the
 * optimistic copy hang forever. Everything that decides "is this the record my
 * pending send became?" lives here rather than inside the page, because getting
 * it wrong is a data bug the reader sees, not a layout detail.
 *
 * THREE RULES THIS FILE EXISTS TO KEEP.
 *
 *   1. A pending send is reaped only by a record that could plausibly BE it: same
 *      text, same attachment ids, and no peer author. The harness's clock can sit
 *      slightly behind the browser's, so the window opens `RECORD_CLOCK_SLACK_MS`
 *      early — but never so far back that an identical OLDER message reaps it.
 *   2. A resend is a NEW delivery attempt and may never inherit the old ledger
 *      identity, or the audit trail quietly rewrites itself.
 *   3. Record identity never truncates. An earlier key hashed only the first 256
 *      characters, so two long assistant messages sharing an opening ("Let me
 *      check the…", a repeated tool preamble) collided and the second was dropped
 *      as already-seen — losing whole streamed paragraphs. `recordUuid` is the
 *      harness's own exact id when present; otherwise the hash covers the WHOLE
 *      string plus its length.
 *
 * WHAT CHANGED. Nothing here reads a store, a connection or a clock it was not
 * given, so it is daemon-agnostic by construction: the page that calls it already
 * holds a `(daemonId, sessionId)` scope, and no key minted here is ever used as a
 * cache key across daemons. `journalEventKey` deliberately keeps the session id in
 * the key it builds, so two daemons' event streams cannot collide inside one
 * page's seen-set.
 */

// biome-ignore-all lint/complexity/useLiteralKeys: event payloads are
// unknown-shaped daemon output, so every field is read through an index
// signature on purpose rather than asserted into a shape we do not control.
import type { FyEvent, SessionView } from '@ferretry/protocol';
import { sameAttachmentIds } from '../lib/attachment-ids.ts';
import type { AttachmentView, StoredTranscriptImage } from '../lib/attachments.ts';
import { peerFrom } from '../lib/peer-message.ts';
import { RECORD_CLOCK_SLACK_MS } from '../lib/send-ledger.ts';
import { TERMINAL_STATUSES } from '../shell/status-mark.tsx';

/** How many records one history page asks the daemon for. */
export const CHAT_PAGE_SIZE = 200;

/**
 * Slack when matching an optimistic send against the real `chat.user` record it
 * became. The record's timestamp comes from the harness's own clock, which can
 * sit slightly behind the browser's.
 *
 * kteam declared this constant twice — once here and once in its send ledger.
 * They are the same fact about the same clock skew, so this reuses the ledger's
 * rather than letting a second copy drift away from it.
 */
export { RECORD_CLOCK_SLACK_MS } from '../lib/send-ledger.ts';

/** One record in a session's chat history, as both history and live frames carry it. */
export interface ChatRecord {
  readonly source: string;
  readonly timestamp?: string;
  readonly type: string;
  readonly data?: unknown;
  /** The harness's own per-record id. Exact identity when present. */
  readonly recordUuid?: string;
  readonly blockIndex?: number;
}

export type PendingStatus = 'sending' | 'queued' | 'delivered' | 'error';

export interface PendingSend {
  readonly key: string;
  readonly text: string;
  readonly status: PendingStatus;
  /**
   * Idempotency key for the LOGICAL message. Every attempt to deliver it — the
   * first, a retry after an error, the interrupt-then-send path — carries this
   * same id, so the daemon applies it exactly once.
   */
  readonly requestId: string;
  /**
   * When the reader sent it. Used to reap against `chat.user` records that
   * arrived AFTER this send, never against an identical older message.
   */
  readonly at: number;
  readonly attachmentIds: readonly string[];
  readonly attachments: readonly StoredTranscriptImage[];
  readonly localAttachmentIds: readonly string[];
}

export type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed';

export interface PendingAttachment {
  readonly localId: string;
  readonly file: File;
  readonly objectUrl?: string;
  readonly status: PendingAttachmentStatus;
  readonly view?: AttachmentView;
  readonly error?: string;
}

/** The part of a rendered user block a pending send is matched against. */
export interface ConfirmableUserBlock {
  readonly kind: string;
  /** A peer author. Present means somebody else sent it, so it is never ours. */
  readonly from?: string;
  readonly ts?: string;
  readonly text: string;
  readonly attachments?: readonly { readonly attachmentId: string }[];
}

/**
 * A pending local send is confirmed by a same-text, in-window `chat.user` record
 * unless peer metadata proves another author sent it.
 *
 * Content classification controls presentation, so it must not strand a locally
 * typed system-like phrase in the optimistic bubble forever.
 */
export const recordConfirmsPending = (
  record: ChatRecord,
  pending: { readonly text: string; readonly at: number },
): boolean => {
  if (record.type !== 'chat.user') return false;
  const raw = String((record.data as { text?: unknown } | undefined)?.text ?? '');
  const { from, body } = peerFrom(raw);
  if (from) return false;
  const at = Date.parse(record.timestamp ?? '') || 0;
  return body.trim() === pending.text && at >= pending.at - RECORD_CLOCK_SLACK_MS;
};

/**
 * The same question asked of an already-rendered block. Attachments must match
 * exactly: a text-identical message with different files is a different message.
 */
export const blockConfirmsPending = (
  block: ConfirmableUserBlock,
  pending: { readonly text: string; readonly at: number; readonly attachmentIds?: readonly string[] },
): boolean => {
  if (block.kind !== 'user' || block.from) return false;
  const at = Date.parse(block.ts ?? '') || 0;
  if (at < pending.at - RECORD_CLOCK_SLACK_MS) return false;
  const pendingIds = pending.attachmentIds ?? [];
  const blockIds = (block.attachments ?? []).map(image => image.attachmentId);
  if (!sameAttachmentIds(blockIds, pendingIds)) return false;
  const text = pending.text.trim();
  return (text.length > 0 || pendingIds.length > 0) && block.text.trim() === text;
};

/**
 * A resend is a new delivery attempt and therefore may never inherit the old
 * ledger identity. The second mint handles an injected/test mint collision; a
 * repeated collision refuses rather than quietly mutating the audit trail.
 */
export const requestIdForLedgerResend = (oldSendId: string, mint: () => string = () => crypto.randomUUID()): string => {
  const first = mint();
  if (first !== oldSendId) return first;
  const second = mint();
  if (second !== oldSendId) return second;
  throw new Error('could not mint a new send identity');
};

/**
 * Is the session — as far as this client AUTHORITATIVELY knows — waiting on an
 * OPEN structured question? True when the daemon's view state says so, either via
 * the `awaiting_question` status OR a `pendingQuestion` object it left in the
 * state. Both come from the session reads, which carry the whole state
 * atomically, so this heals the moment a reconnect or visibility refresh lands
 * even if the live question push flipped neither field.
 *
 * DELIBERATELY NOT derived from the transcript records: the latest question is
 * the last one asked whether or not it was answered, so gating on it would
 * resurrect a form — and block free-text sends — for a session that has already
 * answered and moved on. A terminal session is never awaiting anything, so a
 * stale question is never shown for one.
 */
export const hasOpenQuestion = (view: SessionView | undefined): boolean => {
  if (!view) return false;
  if (TERMINAL_STATUSES.has(view.state.status)) return false;
  return view.state.status === 'awaiting_question' || Boolean(view.state.pendingQuestion);
};

/**
 * The status can lead the question payload during reconnect or reconciliation.
 * Mount a malformed-but-escapable record in that gap instead of hiding both the
 * form and the composer. Its turn-bound key is stable across store refreshes.
 */
export const questionSurfaceRecord = (
  view: SessionView | undefined,
  pendingQuestion: ChatRecord | null | undefined,
): ChatRecord | undefined => {
  if (pendingQuestion) return pendingQuestion;
  if (!view || !hasOpenQuestion(view)) return undefined;
  return {
    source: view.config?.harness ?? 'claude',
    timestamp: `status-only:${view.state.id}:${view.state.turn}`,
    type: 'interaction.question',
    data: { question: 'Question details have not loaded yet.' },
  };
};

/**
 * djb2 over the WHOLE string, plus the length as a cheap collision guard.
 * Truncation is not allowed here — see the file header for what it cost.
 */
export const fieldHash = (value: unknown): string => {
  const text = String(value ?? '');
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return `${(hash >>> 0).toString(36)}:${text.length}`;
};

/** The de-duplication identity of a journal event, always session-qualified. */
export const journalEventKey = (event: FyEvent): string => {
  if (event.sequence > 0) return `${event.sessionId}:${event.sequence}`;
  return `${event.sessionId}:${event.type}:${event.time}:${fieldHash(JSON.stringify(event.data ?? null))}`;
};

/** Every event type the transcript renders. Anything else is not chat. */
const CHAT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'chat.user',
  'chat.assistant.text',
  'chat.assistant.thinking',
  'chat.assistant.reasoning',
  'tool.use',
  'tool.result',
  'interaction.question',
  'interaction.answer',
  'turn.started',
  'turn.completed',
  'turn.aborted',
]);

/**
 * Projects a live event envelope onto a chat record, or `null` when the event is
 * not part of the conversation. `recordUuid` and `blockIndex` are carried through
 * so this live record and its history twin share ONE identity key — that is what
 * stops a reconnect's backfill from re-appending the tail.
 */
export const eventToRecord = (event: FyEvent): ChatRecord | null => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  if (!CHAT_EVENT_TYPES.has(event.type)) return null;
  const source = typeof data['source'] === 'string' ? data['source'] : event.source;
  return {
    source: source === 'claude' || source === 'codex' ? source : 'claude',
    timestamp: typeof data['timestamp'] === 'string' ? data['timestamp'] : event.time,
    type: event.type,
    data,
    ...(event.recordUuid === undefined ? {} : { recordUuid: event.recordUuid }),
    ...(event.blockIndex === undefined ? {} : { blockIndex: event.blockIndex }),
  };
};

/** Identity of one chat record, for live-vs-history de-duplication. */
export const recordKey = (record: ChatRecord): string => {
  const data = record.data as Record<string, unknown> | undefined;
  // `recordUuid` + `blockIndex` sit at the TOP level of a history record and of a
  // live chat frame alike — one exact identity shared by both paths.
  if (record.recordUuid) return `${record.source}|${record.type}|${record.recordUuid}|${record.blockIndex ?? ''}`;
  let signature = '';
  if (data) {
    if ('text' in data) signature += `t=${fieldHash(data['text'])}`;
    if ('thinking' in data) signature += `th=${fieldHash(data['thinking'])}`;
    if ('reasoning' in data) signature += `r=${fieldHash(data['reasoning'])}`;
    if ('toolUseId' in data) signature += `id=${String(data['toolUseId'] ?? '')}`;
    if ('isError' in data) signature += `e=${String(data['isError'] ?? '')}`;
  }
  return `${record.source}|${record.type}|${record.timestamp ?? ''}|${signature}`;
};

/**
 * What the optimistic bubble says in each state, and why it stops where it does.
 *
 * `delivered` USED TO BE GREEN AND SAY "delivered". It no longer does, because at
 * that point the only thing that has happened is that the daemon accepted the
 * message and reported a disposition — the app's own belief, not harness proof.
 * That is exactly the class of claim to stop making: a green "delivered" on an
 * HTTP 200 is how a message that never reached the agent gets reported as read.
 * "sent" would assert that keystrokes reached the pane, which is unknown here, so
 * the optimistic row tops out at "accepted — awaiting confirmation" and the
 * durable ledger chip takes over from there. `queued` keeps its wording because
 * that disposition IS the harness's native input queue.
 */
export const PENDING_BADGE: Record<PendingStatus, { readonly label: string; readonly tone: string }> = {
  sending: { label: 'sending', tone: 'border-border bg-surface-2 text-muted' },
  queued: { label: 'queued for next turn', tone: 'border-warn-border bg-warn-bg text-warn' },
  delivered: { label: 'accepted — awaiting confirmation', tone: 'border-warn-border bg-warn-bg text-warn' },
  error: { label: 'failed to send', tone: 'border-err-border bg-err-bg text-err' },
};
