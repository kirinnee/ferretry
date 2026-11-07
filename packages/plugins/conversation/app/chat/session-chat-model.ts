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
import type { FerretView } from '@ferretry/core-ferrets/contract';
import type { AttachmentView } from '../composer/attachments.ts';
import { TERMINAL_STATUSES } from '@ferretry/app';

export type PendingStatus = 'sending' | 'queued' | 'delivered' | 'error';

/**
 * `deferred`: the connection is gone, so the file is not uploaded now — it goes to this device's outbox with the
 * message and is uploaded there, before the send, once the machine answers again.
 */
type PendingAttachmentStatus = 'uploading' | 'ready' | 'failed' | 'deferred';

export interface PendingAttachment {
  readonly localId: string;
  readonly file: File;
  readonly objectUrl?: string;
  readonly status: PendingAttachmentStatus;
  readonly view?: AttachmentView;
  readonly error?: string;
  /** What an upload that has not finished is doing instead — waiting its turn, or retrying a drop. */
  readonly note?: string;
  /**
   * The file's size when `file` does not hold its bytes: a file another of the owner's devices attached,
   * which this one only names.
   */
  readonly size?: number;
  /** `false` for a placeholder this device cannot remove: another device's upload still on its way. */
  readonly removable?: false;
}

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
export const hasOpenQuestion = (view: FerretView | undefined): boolean => {
  if (!view) return false;
  if (TERMINAL_STATUSES.has(view.state.status)) return false;
  return view.state.status === 'awaiting_question' || Boolean(view.state.pendingQuestion);
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

/** The fields of a journal event its de-duplication identity reads (today's `FyEvent`). */
export interface JournalEventIdentity {
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: string;
  readonly time: string;
  readonly data?: unknown;
}

/** The de-duplication identity of a journal event, always session-qualified. */
export const journalEventKey = (event: JournalEventIdentity): string => {
  if (event.sequence > 0) return `${event.sessionId}:${event.sequence}`;
  return `${event.sessionId}:${event.type}:${event.time}:${fieldHash(JSON.stringify(event.data ?? null))}`;
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
