/**
 * Readers for the v4 Conversation files (docs/migration/v4-formats.md §1–2; source `origin/main` at 4.291.5).
 *
 * LOCAL COPIES ON PURPOSE: the product has no v4 reader. Each schema below is the v4 writer's own shape, named after
 * the file it came from, and is lenient exactly where the v4 reader was (a plain `z.object` keeps unknown keys out of
 * the result instead of refusing them). Nothing here maps to v5: the files whose v5 shape is still moving on the
 * Conversation port are only read and checked, and their mapping is written once that port lands.
 *
 * Errors name a file relative to the v4 home and never carry a value from it (no zod message is ever passed on: a zod
 * issue can quote the input). A sealed file is never opened here.
 */
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { z } from 'zod';

/** `state/session-message-token.key`: 32 raw bytes, 0600 (`file-message-token-codec.ts`). Moved, never opened. */
export const V4_MESSAGE_TOKEN_KEY = 'session-message-token.key';
export const V4_MESSAGE_TOKEN_KEY_MODE = 0o600;

const Instant = z.iso.datetime({ offset: true });
const NonNegative = z.number().int().nonnegative();
const Positive = z.number().int().positive();

/** Thrown for an unusable v4 input. The message names the file and nothing from inside it. */
export class V4InputError extends Error {
  constructor(problem: string, file: string) {
    super(`${problem}: ${file}`);
    this.name = 'V4InputError';
  }
}

export interface V4Reader {
  /** The v4 home, so errors name files relative to it. */
  readonly home: string;
}

const named = (reader: V4Reader, path: string): string => relative(reader.home, path) || path;

export async function entry(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error('cannot inspect v4 input');
  }
}

/** One JSON document, or `undefined` when it does not exist. A link or a non-file is refused, never followed. */
export async function readJson<Shape>(
  reader: V4Reader,
  path: string,
  schema: z.ZodType<Shape>,
): Promise<Shape | undefined> {
  const source = await entry(path);
  if (source === undefined) return undefined;
  if (!source.isFile()) throw new V4InputError('v4 document is not a regular file', named(reader, path));
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new V4InputError('v4 document is not JSON', named(reader, path));
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new V4InputError('v4 document does not match its v4 schema', named(reader, path));
  return parsed.data;
}

/**
 * Every line of an append-only v4 log, in order. A final line with no newline that does not parse is a crash during
 * the append (the v4 readers skip it) and is skipped here too; any other bad line refuses the file.
 */
export async function readJsonl<Shape>(
  reader: V4Reader,
  path: string,
  schema: z.ZodType<Shape>,
): Promise<readonly Shape[]> {
  const source = await entry(path);
  if (source === undefined) return [];
  if (!source.isFile()) throw new V4InputError('v4 log is not a regular file', named(reader, path));
  const text = await readFile(path, 'utf8');
  const lines = text.split('\n');
  const complete = text.endsWith('\n');
  const result: Shape[] = [];
  for (const [index, raw] of lines.entries()) {
    if (raw.trim() === '') continue;
    const last = index === lines.length - 1;
    let value: unknown;
    let ok = true;
    try {
      value = JSON.parse(raw);
    } catch {
      ok = false;
    }
    const parsed = ok ? schema.safeParse(value) : undefined;
    if (parsed?.success === true) {
      result.push(parsed.data);
      continue;
    }
    if (last && !complete) continue;
    throw new V4InputError(`v4 log line ${index + 1} does not match its v4 schema`, named(reader, path));
  }
  return result;
}

/** The names in a folder; a link anywhere in it refuses the folder (never traverse out of the home). */
export async function names(reader: V4Reader, path: string): Promise<readonly { name: string; folder: boolean }[]> {
  const source = await entry(path);
  if (source === undefined) return [];
  if (!source.isDirectory()) throw new V4InputError('v4 folder is not a directory', named(reader, path));
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some(item => item.isSymbolicLink()))
    throw new V4InputError('v4 folder contains a link', named(reader, path));
  return entries
    .map(item => ({ name: item.name, folder: item.isDirectory() }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

// ── shared vocabulary (protocol/src/lib/session.ts, session-queue.ts) ─────────────────────────────────────────────

const SenderKind = z.enum(['human', 'agent', 'daemon']);
const Label = z.enum(['blocker', 'action', 'fyi']);
const QueueAuthor = z.strictObject({
  kind: z.enum(['owner', 'ferret', 'ferretry']),
  name: z.string().min(1).optional(),
  feature: z.string().min(1).optional(),
  sections: z.array(z.string().min(1).max(64)).min(1).max(16).optional(),
});
const QueueWaitReason = z.enum(['launching', 'busy', 'question', 'dialog', 'draft', 'unreadable', 'stopped']);
const QueuedState = z.enum(['queued', 'typing', 'delivered', 'read', 'unconfirmed', 'cancelled', 'failed']);
type QueuedState = z.infer<typeof QueuedState>;
const QueuedId = z.string().min(1).max(128);

// ── channel/queue.jsonl: an event log, folded into messages (lib/session/queue/model.ts) ───────────────────────────

export const V4QueuedMessage = z.object({
  v: z.literal(1),
  id: QueuedId,
  sender: SenderKind,
  from: z.string().optional(),
  fromName: z.string().optional(),
  by: QueueAuthor.optional(),
  text: z.string(),
  attachmentIds: z.array(z.string()),
  replyExpected: z.boolean().optional(),
  interrupt: z.boolean().optional(),
  label: Label.optional(),
  holdUntil: Instant.optional(),
  deliveredAs: z.string().min(1).optional(),
  enqueuedAt: Instant,
  state: QueuedState,
  stateAt: Instant,
  revision: Positive,
  waitReason: QueueWaitReason.optional(),
  waitBehind: z.string().min(1).optional(),
  failure: z.string().optional(),
  version: Positive.optional(),
});
export type V4QueuedMessage = z.infer<typeof V4QueuedMessage>;

export const V4QueueEvent = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('enqueued'), at: Instant, message: V4QueuedMessage }),
  z.object({
    v: z.literal(1),
    kind: z.literal('edited'),
    at: Instant,
    id: QueuedId,
    text: z.string(),
    revision: z.number().int().min(2),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('moved'),
    at: Instant,
    id: QueuedId,
    state: QueuedState,
    failure: z.string().optional(),
    batch: z.string().min(1).optional(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('waiting'),
    at: Instant,
    id: QueuedId,
    reason: QueueWaitReason.optional(),
    behind: z.string().min(1).optional(),
  }),
]);
export type V4QueueEvent = z.infer<typeof V4QueueEvent>;

const NEXT: Readonly<Record<QueuedState, readonly QueuedState[]>> = {
  queued: ['typing', 'cancelled', 'failed'],
  typing: ['queued', 'delivered', 'unconfirmed', 'failed'],
  delivered: ['read'],
  unconfirmed: ['delivered', 'read'],
  read: [],
  cancelled: [],
  failed: [],
};

function applied(message: V4QueuedMessage, event: Exclude<V4QueueEvent, { kind: 'enqueued' }>): V4QueuedMessage {
  switch (event.kind) {
    case 'edited':
      return message.state === 'queued' && event.revision === message.revision + 1
        ? { ...message, text: event.text, revision: event.revision }
        : message;
    case 'moved': {
      if (!NEXT[message.state].includes(event.state)) return message;
      const { waitReason: _reason, waitBehind: _behind, failure: _failure, deliveredAs: batch, ...rest } = message;
      const deliveredAs = event.state === 'typing' ? event.batch : event.state === 'queued' ? undefined : batch;
      return {
        ...rest,
        ...(deliveredAs === undefined ? {} : { deliveredAs }),
        state: event.state,
        stateAt: event.at,
        ...(event.state === 'failed' && event.failure !== undefined ? { failure: event.failure } : {}),
      };
    }
    case 'waiting': {
      if (message.state !== 'queued') return message;
      const { waitReason: _reason, waitBehind: _behind, ...rest } = message;
      if (event.reason === undefined) return rest;
      return { ...rest, waitReason: event.reason, ...(event.behind === undefined ? {} : { waitBehind: event.behind }) };
    }
  }
}

/** v4's own fold (`foldQueue`), copied: the messages the log describes, in the order first accepted. */
export function foldV4Queue(events: readonly V4QueueEvent[]): readonly V4QueuedMessage[] {
  const messages = new Map<string, V4QueuedMessage>();
  let position = 0;
  for (const event of events) {
    position += 1;
    if (event.kind === 'enqueued') {
      if (!messages.has(event.message.id)) messages.set(event.message.id, { ...event.message, version: position });
      continue;
    }
    const current = messages.get(event.id);
    if (current === undefined) continue;
    const next = applied(current, event);
    messages.set(event.id, next === current ? current : { ...next, version: position });
  }
  return [...messages.values()];
}

// ── channel/sends.jsonl: the daemon's own ledger records, last line per sendId wins (file-send-ledger.ts) ──────────

const SendEvidence = z.object({
  key: z.string().min(1),
  harness: z.enum(['claude', 'codex']),
  kind: z.enum(['chat.user', 'queued_command', 'response_item']),
  proof: z.enum(['normal-user-record', 'native-queue-drain']),
  observedAt: Instant,
  originatedAt: Instant.optional(),
  shapeVersion: Positive,
  matchedTurn: NonNegative,
  tier: z.enum(['queue-file-id', 'turn-instruction', 'exact-text', 'merged-text']),
});

/**
 * One ledger line as v4 WROTE it: the internal `SendRecord` (`lib/session/send/types.ts`) plus the append's `at` and
 * a withdrawal's `reason`. Unlike the wire view it holds `withdrawn` as a fate, private bookkeeping (`matchText`,
 * `payloadFile`, `batch`, `submitNudges`, `busyTyped`, `untyped`, `noticesOwed`) and `session_ended`.
 */
export const V4SendLine = z.object({
  sendId: z.string().min(1),
  acceptedAt: Instant,
  acceptedTurn: NonNegative,
  path: z.enum(['direct', 'turn-file', 'native-inline', 'native-file', 'revive', 'revive-queue']),
  message: z.string(),
  matchText: z.string().optional(),
  turn: NonNegative.optional(),
  attachmentIds: z.array(z.string()).optional(),
  from: z.string().optional(),
  fromName: z.string().optional(),
  senderKind: SenderKind.optional(),
  batch: z.array(z.object({ queueId: z.string(), from: z.string() })).optional(),
  by: QueueAuthor.optional(),
  replyExpected: z.boolean().optional(),
  payloadFile: z.string().optional(),
  held: z.boolean().optional(),
  fate: z.enum(['accepted', 'queued', 'delivered', 'unaccounted', 'timed_out', 'withdrawn', 'cancelled']),
  fateAt: Instant.optional(),
  evidence: SendEvidence.optional(),
  unaccountedReason: z
    .enum([
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
    ])
    .optional(),
  queuedAt: Instant.optional(),
  queueProof: z.enum(['transcript', 'pane']).optional(),
  attempt: Positive.optional(),
  attemptAt: Instant.optional(),
  deadlineAt: Instant.optional(),
  retryable: z.boolean().optional(),
  typedNotSent: z.boolean().optional(),
  submitNudges: NonNegative.optional(),
  busyTyped: z.boolean().optional(),
  untyped: z.boolean().optional(),
  cancelEffect: z.enum(['cleared', 'not_in_pane', 'left_in_queue', 'left_in_composer']).optional(),
  noticesOwed: z.array(z.object({ from: z.string(), sendId: z.string() })).optional(),
  opportunityAt: Instant.optional(),
  unaccountedDeadline: Instant.optional(),
  hardDeadline: Instant.optional(),
  timeoutFrozenAt: Instant.optional(),
  at: Instant.optional(),
  reason: z.string().optional(),
});
export type V4SendLine = z.infer<typeof V4SendLine>;

/** The ledger as v4 read it: the latest line for each send, in the order each send first appeared. */
export function latestV4Sends(lines: readonly V4SendLine[]): readonly V4SendLine[] {
  const latest = new Map<string, V4SendLine>();
  for (const line of lines) latest.set(line.sendId, line);
  return [...latest.values()];
}

// ── channel/answers.jsonl: answer receipts, latest per requestId (file-answer-ledger.ts) ──────────────────────────

/**
 * A receipt, not an answer: it holds a `fingerprint` of what was answered, never the labels. Newer outcomes are
 * written as `accepted` with the real one in `resolution` (rollback safety), so the outcome is `resolution ?? outcome`.
 */
export const V4AnswerReceipt = z.object({
  requestId: z.string().min(1),
  toolUseId: z.string().min(1),
  fingerprint: z.string().min(1),
  acceptedAt: Instant,
  outcome: z.enum(['accepted', 'confirmed', 'withdrawn', 'failed', 'quarantined', 'acknowledged']),
  resolution: z.enum(['failed', 'quarantined', 'acknowledged']).optional(),
  reason: z.string().optional(),
  at: Instant.optional(),
});
export type V4AnswerReceipt = z.infer<typeof V4AnswerReceipt>;

export function latestV4Answers(lines: readonly V4AnswerReceipt[]): readonly V4AnswerReceipt[] {
  const latest = new Map<string, V4AnswerReceipt>();
  for (const line of lines) latest.set(line.requestId, line);
  return [...latest.values()];
}

// ── channel/inbox.jsonl and outbox.jsonl: untyped audit logs (file-send-channel.ts) ───────────────────────────────

export const V4InboxLine = z.object({
  at: Instant,
  type: z.literal('message'),
  message: z.string(),
  turn: NonNegative.optional(),
  queued: z.boolean().optional(),
  queueId: z.string().optional(),
  queuedForRevive: z.boolean().optional(),
  reason: z.string().optional(),
  from: z.string().optional(),
  fromName: z.string().optional(),
});
export type V4InboxLine = z.infer<typeof V4InboxLine>;

export const V4OutboxLine = z.object({
  at: Instant,
  type: z.string().min(1),
  from: z.string(),
  fromName: z.string().optional(),
  to: z.string(),
  disposition: z.string(),
  message: z.string(),
});
export type V4OutboxLine = z.infer<typeof V4OutboxLine>;

// ── question-asked.json: the raw Claude PreToolUse hook payload (lib/session/question/asked.ts) ────────────────────

export const V4AskedQuestion = z.object({
  hook_event_name: z.literal('PreToolUse'),
  tool_name: z.literal('AskUserQuestion'),
  tool_use_id: z.string().trim().min(1),
  transcript_path: z.string().min(1).optional(),
  tool_input: z.object({
    questions: z
      .array(
        z.object({
          question: z.string(),
          header: z.string().optional(),
          options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
          multiSelect: z.boolean().optional(),
          multi_select: z.boolean().optional(),
        }),
      )
      .min(1),
  }),
});
export type V4AskedQuestion = z.infer<typeof V4AskedQuestion>;

// ── state/shared-drafts/<sid>.json and <sid>.items/<agendaId>.json (protocol/src/lib/shared-draft.ts) ────────────

const DraftItem = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('attachment'),
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(255),
    mime: z.string().min(1).max(255),
    bytes: NonNegative,
  }),
  z.strictObject({
    kind: z.literal('location'),
    id: z.string().min(1).max(128),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    accuracyMeters: z.number().nonnegative(),
    capturedAt: NonNegative,
    place: z.string().max(80).optional(),
  }),
]);
export const V4AgendaId = z.string().regex(/^A[1-9][0-9]*$/u);

export const V4SharedDraft = z.strictObject({
  v: z.literal(1),
  sessionId: z.string().min(1),
  slot: V4AgendaId.optional(),
  generation: z.string().min(1).max(64),
  epoch: NonNegative,
  rev: NonNegative,
  text: z.string().max(16_000),
  items: z.array(DraftItem).max(20).readonly(),
  updatedAt: Instant,
});
export type V4SharedDraft = z.infer<typeof V4SharedDraft>;

export const sharedDraftsFolder = (state: string) => join(state, 'shared-drafts');

// ── state/attachments/<daemonId>/<sid>/<attachmentId>/{original,manifest.json} (lib/attachments) ──────────────────

/** The manifest only; `original` is bytes and is never opened by this tool. */
export const V4AttachmentManifest = z.strictObject({
  id: z.string().min(1),
  filename: z.string().min(1),
  mime: z.string().min(1),
  size: NonNegative,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: Instant,
  encrypted: z.strictObject({ kind: z.literal('pdf') }).optional(),
});
export type V4AttachmentManifest = z.infer<typeof V4AttachmentManifest>;

// ── state/renders/<id[0:2]>/<id>.json + <id>.payload (adapters/renders/file-render-repository.ts) ─────────────────

export const V4RenderId = z.string().regex(/^[0-9a-hjkmnp-tv-z]{6,52}$/u);
export const V4RenderMeta = z.object({
  v: z.literal(1),
  id: V4RenderId,
  kind: z.enum(['svg', 'html']),
  alt: z.string(),
  bytes: NonNegative,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: Instant,
  author: z.strictObject({ sessionId: z.string().min(1).optional() }),
  supersedes: V4RenderId.optional(),
});
export type V4RenderMeta = z.infer<typeof V4RenderMeta>;
