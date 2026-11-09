/**
 * Conversation: what a ferret was told, sent, asked and is typing, what it was handed and drew, and the key that signs
 * links to its messages. The v5 owner is `@ferretry/plugin-conversation`; every path below is one of its
 * `defineState` declarations, under `state/conversation/` (§9.2).
 *
 * - `state/session-message-token.key` → `message-token.key`, byte for byte, never opened.
 * - `sessions/<sid>/turns/` → `state/ferrets/sessions/<sid>/turns/` (the one place v5 reads them: Ferrets' internal
 *   `sessions` root, not Conversation's folder), every file byte for byte, links omitted.
 * - `shared-drafts/<sid>.json` + `<sid>.items/<askId>.json` → `<sid>/drafts` (opaque): the drafts repository's one
 *   document `{chat, items}`, each snapshot parsed by v5's `DraftSnapshotSchema` (`sessionId` becomes `ferret`).
 * - `links.json` from every ferret v4 kept from an existing conversation (`transcript.identity` `adopted`).
 * - `channel/{queue,sends,answers,inbox,outbox}.jsonl` → `<sid>/<same>.jsonl`, line for line, in order. The kernel's
 *   JSONL store stamps `"format": 1` on every line and strips it on read, so each line gains it; each line is then
 *   parsed by the line schema below, which is the v5 store's own line shape built from the contract's schemas. The
 *   line schemas live here because v5 keeps them private to its daemon (`queue/lib/model.ts` `QueueEventSchema`, the
 *   internal `SendRecord` of `delivery/lib/types.ts`, `questions/adapters/state-answer-ledger.ts`,
 *   `delivery/adapters/state-send-channel.ts`); a send line is also projected to the wire view and parsed by the
 *   contract's `SendRecordSchema`, as v5's `sendRecordView` serves it.
 * - `question-asked.json` of a LIVE ferret → `<sid>/question.json`, parsed by `QuestionSchema` exactly as v5's one
 *   writer (`writeAskedQuestion`) stores it: one question, proved against the ferret's own transcript (rewritten into
 *   the new home), `askedAt` = the v4 file's mtime (the hook replaced the file whole per question).
 * - `attachments/<daemonId>/<sid>/<attId>/{original,manifest.json}` → `attachments/<sid>~<attId>.original` (byte for
 *   byte, never opened) and `.manifest` (re-encoded exactly as v5's store writes one, checked as its parser checks).
 * - `renders/<id[0:2]>/<id>.{json,payload}` → `renders/<id>.json` (`StoredRenderMetaSchema`, `author.sessionId` →
 *   `author.ferret`) and `renders/<id>.payload` (byte for byte), unsharded.
 *
 * A line or document v5 would refuse fails the step naming the file (and line), never a value from it.
 */
import {
  ANSWERS_STATE,
  ATTACHMENT_MANIFEST_STATE,
  ATTACHMENT_ORIGINAL_STATE,
  AttachmentViewSchema,
  DraftSnapshotSchema,
  DRAFTS_STATE,
  INBOX_STATE,
  LINKS_STATE,
  LinksFileSchema,
  MESSAGE_TOKEN_KEY_STATE,
  OUTBOX_STATE,
  QUESTION_STATE,
  QuestionSchema,
  QUEUE_STATE,
  QueueAuthorSchema,
  QueuedMessageIdSchema,
  QueuedMessageSchema,
  QueuedMessageStateSchema,
  QueueWaitReasonSchema,
  RENDER_META_STATE,
  RENDER_PAYLOAD_STATE,
  SendCancelEffectSchema,
  SendDispositionSchema,
  SenderKindSchema,
  SendEvidenceSchema,
  SendFateSchema,
  SendPathSchema,
  SendRecordSchema,
  SENDS_STATE,
  SendUnaccountedReasonSchema,
  StoredRenderMetaSchema,
} from '@ferretry/plugin-conversation/contract';
import { chmod, mkdir, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { FERRET_SESSIONS_FOLDER, FERRET_TURNS_FOLDER } from '@ferretry/core-ferrets/contract';
import type { KeptItem, StepReport } from '../report.ts';
import { moveSealed } from '../sealed.ts';
import {
  entry,
  foldV4Queue,
  latestV4Answers,
  latestV4Sends,
  names,
  readJson,
  readJsonlLines,
  sharedDraftsFolder,
  V4AgendaId,
  V4AnswerReceipt,
  V4AskedQuestion,
  V4AttachmentManifest,
  V4InboxLine,
  V4InputError,
  V4_MESSAGE_TOKEN_KEY,
  V4_MESSAGE_TOKEN_KEY_MODE,
  V4OutboxLine,
  V4QueueEvent,
  V4RenderMeta,
  V4SendLine,
  V4SharedDraft,
  type V4Reader,
  type V4SendLine as V4Send,
} from '../v4/conversation.ts';
import { configs, json, runtimeIds, State, type V4Config } from '../v4/ferrets.ts';
import { rewriteTranscript } from '../v5/harness-paths.ts';
import type { Step, StepContext } from './index.ts';

/** `state/conversation/` — the plugin's state folder (§9.2); the declarations' paths are relative to it. */
export const V5_CONVERSATION = 'state/conversation';
const at = (path: string, name?: string) => join(V5_CONVERSATION, name === undefined ? path : path.replace('*', name));
export const V5_MESSAGE_TOKEN_KEY_FILE = at(MESSAGE_TOKEN_KEY_STATE.path);
export const V5_LINKS_FILE = at(LINKS_STATE.path);
/**
 * A ferret's turns folder in 5.0: `<FERRET_SESSIONS_FOLDER>/<ferret>/<FERRET_TURNS_FOLDER>`, the facts Ferrets' contract
 * owns (`contract/sessions-root.ts`), so this step and 5.0's readers (`FileSessionTaskStore` `turns/turn-001.md`,
 * `FileResumeTurnStore` `turns/turn-NNN.md`) name one folder. Conversation's `TURNS_STATE` is read by nothing.
 */
export const v5TurnsFolder = (ferret: string) => join(FERRET_SESSIONS_FOLDER, ferret, FERRET_TURNS_FOLDER);
export const v5DraftsFile = (ferret: string) => at(DRAFTS_STATE.path, ferret);
export const v5QueueFile = (ferret: string) => at(QUEUE_STATE.path, ferret);
export const v5SendsFile = (ferret: string) => at(SENDS_STATE.path, ferret);
export const v5AnswersFile = (ferret: string) => at(ANSWERS_STATE.path, ferret);
export const v5InboxFile = (ferret: string) => at(INBOX_STATE.path, ferret);
export const v5OutboxFile = (ferret: string) => at(OUTBOX_STATE.path, ferret);
export const v5QuestionFile = (ferret: string) => at(QUESTION_STATE.path, ferret);
/** `attachments/<ferret>~<attachment id>.original|.manifest`: `~` is in neither id, so a name splits one way only. */
export const v5AttachmentOriginal = (ferret: string, id: string) =>
  at(ATTACHMENT_ORIGINAL_STATE.path, `${ferret}~${id}`);
export const v5AttachmentManifest = (ferret: string, id: string) =>
  at(ATTACHMENT_MANIFEST_STATE.path, `${ferret}~${id}`);
export const v5RenderMeta = (id: string) => at(RENDER_META_STATE.path, id);
export const v5RenderPayload = (id: string) => at(RENDER_PAYLOAD_STATE.path, id);

/**
 * The inside of the opaque `drafts` file, as v5's `StateDraftRepository` reads it: the chat draft, and one reply draft
 * per agenda item keyed by its id (each item snapshot names its `slot`).
 */
export const DraftsDocumentSchema = z.strictObject({
  chat: DraftSnapshotSchema.optional(),
  items: z.record(z.string().regex(/^A[1-9][0-9]*$/u), DraftSnapshotSchema),
});

// ── the v5 line shapes (each a v5 store's own, plus the kernel's `format` stamp) ───────────────────────────────────

/** The kernel stamps it first on every JSONL line (`kernel/host/state/format.ts`) and a reader accepts exactly 1. */
const Format = z.literal(1);
/** v5's `InstantSchema`, taken from the contract rather than imported from a product package. */
const Instant = QueuedMessageSchema.shape.enqueuedAt;
const NonNegative = z.number().int().nonnegative();
const Positive = z.number().int().positive();
/** The kernel's per-record bound (`kernel/host/state/jsonl-scan.ts` `MAX_JSONL_RECORD_BYTES`): a longer line damages the file. */
export const V5_MAX_JSONL_LINE_BYTES = 1 << 20;

/** One `queue.jsonl` line: v5's `QueueEventSchema` (`queue/lib/model.ts`), whose message is the contract's. */
export const V5QueueLineSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    format: Format,
    v: z.literal(1),
    kind: z.literal('enqueued'),
    at: Instant,
    message: QueuedMessageSchema,
  }),
  z.strictObject({
    format: Format,
    v: z.literal(1),
    kind: z.literal('edited'),
    at: Instant,
    id: QueuedMessageIdSchema,
    text: z.string(),
    revision: z.number().int().min(2),
  }),
  z.strictObject({
    format: Format,
    v: z.literal(1),
    kind: z.literal('moved'),
    at: Instant,
    id: QueuedMessageIdSchema,
    state: QueuedMessageStateSchema,
    failure: z.string().optional(),
    batch: z.string().min(1).optional(),
  }),
  z.strictObject({
    format: Format,
    v: z.literal(1),
    kind: z.literal('waiting'),
    at: Instant,
    id: QueuedMessageIdSchema,
    reason: QueueWaitReasonSchema.optional(),
    behind: z.string().min(1).optional(),
  }),
]);

/**
 * One `sends.jsonl` line: v5's internal `SendRecord` (`delivery/lib/types.ts`) as `StateSendLedger` appends it, with
 * the append's `at` and a withdrawal's `reason`. Unlike the wire view it keeps `withdrawn` as a fate and the ledger's
 * private bookkeeping (`matchText`, `batch`, `submitNudges`, `busyTyped`, `untyped`, `noticesOwed`).
 */
export const V5SendLineSchema = z.strictObject({
  format: Format,
  sendId: z.string().min(1),
  acceptedAt: Instant,
  acceptedTurn: NonNegative,
  path: SendPathSchema,
  message: z.string(),
  matchText: z.string().optional(),
  turn: NonNegative.optional(),
  attachmentIds: z.array(z.string()).optional(),
  from: z.string().optional(),
  fromName: z.string().optional(),
  senderKind: SenderKindSchema.optional(),
  batch: z.array(z.strictObject({ queueId: z.string(), from: z.string() })).optional(),
  by: QueueAuthorSchema.optional(),
  replyExpected: z.boolean().optional(),
  held: z.boolean().optional(),
  fate: z.union([SendFateSchema, z.literal('withdrawn')]),
  fateAt: Instant.optional(),
  evidence: SendEvidenceSchema.optional(),
  unaccountedReason: SendUnaccountedReasonSchema.optional(),
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
  cancelEffect: SendCancelEffectSchema.optional(),
  noticesOwed: z.array(z.strictObject({ from: z.string(), sendId: z.string() })).optional(),
  at: Instant.optional(),
  reason: z.string().optional(),
});
type V5SendLine = z.infer<typeof V5SendLineSchema>;

/** One `answers.jsonl` line: the answer ledger's receipt as `StateAnswerLedger` appends and parses it. */
export const V5AnswerLineSchema = z.strictObject({
  format: Format,
  requestId: z.string().min(1),
  toolUseId: z.string().min(1),
  fingerprint: z.string().min(1),
  acceptedAt: Instant,
  outcome: z.enum(['accepted', 'confirmed', 'withdrawn', 'failed', 'quarantined', 'acknowledged']),
  resolution: z.enum(['failed', 'quarantined', 'acknowledged']).optional(),
  reason: z.string().optional(),
  at: Instant.optional(),
});

/** One `inbox.jsonl` line, as `StateSendChannel.recordInbound` appends it. */
export const V5InboxLineSchema = z.strictObject({
  format: Format,
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

/** One `outbox.jsonl` line, as `StateSendChannel.recordOutbound` appends it. */
export const V5OutboxLineSchema = z.strictObject({
  format: Format,
  at: Instant,
  type: z.literal('message'),
  from: z.string(),
  fromName: z.string().optional(),
  to: z.string(),
  disposition: SendDispositionSchema,
  message: z.string(),
});

// ── v4 → v5 mappings (pure) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A v4 ledger line in v5's words. `session_ended` is `ferret_ended`. Dropped: `payloadFile` (an absolute path to the
 * v4 `channel/queued-<id>.md`, which v5 never reads back and has no declared place for; the message is in `message`
 * and what was typed in `matchText`), and `opportunityAt`, `unaccountedDeadline`, `hardDeadline`, `timeoutFrozenAt`
 * (v4 tracker timers v5's record does not have and nothing in v5 reads).
 */
export function v5SendLine(line: V4Send): unknown {
  const {
    payloadFile: _payload,
    opportunityAt: _opportunity,
    unaccountedDeadline: _unaccounted,
    hardDeadline: _hard,
    timeoutFrozenAt: _frozen,
    unaccountedReason,
    ...rest
  } = line;
  return {
    format: 1,
    ...rest,
    ...(unaccountedReason === undefined
      ? {}
      : { unaccountedReason: unaccountedReason === 'session_ended' ? 'ferret_ended' : unaccountedReason }),
  };
}

/** The wire view of a ledger line, exactly as v5's `sendRecordView` projects one (a withdrawn send is a tombstone). */
export function v5SendView(line: V5SendLine): unknown {
  const withdrawn = line.fate === 'withdrawn';
  const keep = <K extends keyof V5SendLine>(key: K) => (line[key] === undefined ? {} : { [key]: line[key] });
  return {
    v: 1,
    sendId: line.sendId,
    acceptedAt: line.acceptedAt,
    acceptedTurn: line.acceptedTurn,
    path: line.path,
    message: line.message,
    attachmentIds: [...(line.attachmentIds ?? [])],
    fate: withdrawn ? 'accepted' : line.fate,
    ...(withdrawn ? { withdrawn: true } : {}),
    ...keep('turn'),
    ...keep('from'),
    ...keep('fromName'),
    ...keep('senderKind'),
    ...keep('by'),
    ...keep('replyExpected'),
    ...keep('held'),
    ...keep('fateAt'),
    ...keep('evidence'),
    ...keep('unaccountedReason'),
    ...keep('queuedAt'),
    ...keep('queueProof'),
    ...keep('attempt'),
    ...keep('attemptAt'),
    ...keep('deadlineAt'),
    ...keep('retryable'),
    ...keep('typedNotSent'),
    ...keep('cancelEffect'),
  };
}

/**
 * The open question as v5's `writeAskedQuestion` stores it, or `undefined` where that writer stores nothing: several
 * questions at once (a `Question` holds one), a payload naming another transcript than the ferret's, a transcript
 * that has no place in the new home, or a question v5's schema refuses. v5 then reads the question from the
 * transcript, which is what that writer's refusal means too.
 */
export function v5Question(
  asked: V4AskedQuestion,
  askedAt: Date,
  ferretTranscript: string | undefined,
  v5Transcript: string | undefined,
): z.infer<typeof QuestionSchema> | undefined {
  const [first, ...more] = asked.tool_input.questions;
  if (first === undefined || more.length > 0) return undefined;
  if (asked.transcript_path === undefined || asked.transcript_path !== ferretTranscript || v5Transcript === undefined)
    return undefined;
  const parsed = QuestionSchema.safeParse({
    format: 1,
    toolUseId: asked.tool_use_id,
    ...(first.header === undefined ? {} : { header: first.header }),
    text: first.question,
    options: (first.options ?? []).map(({ label, description }) =>
      description === undefined ? { label } : { label, description },
    ),
    multiple: first.multiSelect === true || first.multi_select === true,
    askedAt: askedAt.toISOString(),
    transcript: v5Transcript,
  });
  return parsed.success ? parsed.data : undefined;
}

const SAFE_FILENAME = /^[^/\\\0]+$/u;

/**
 * A v4 manifest as v5's store writes one, or `undefined` when v5's `parseStoredAttachmentManifest` would read it as
 * corrupt: the facts must satisfy the contract's `AttachmentViewSchema`, the id must be `att_<sha256>` and the folder
 * it was found in, and the filename can never be read back as a path. The key order is the store's own.
 */
export function v5AttachmentManifestDocument(manifest: V4AttachmentManifest, folderId: string) {
  const view = AttachmentViewSchema.safeParse({
    id: manifest.id,
    filename: manifest.filename,
    mime: manifest.mime,
    size: manifest.size,
    sha256: manifest.sha256,
    createdAt: manifest.createdAt,
    ...(manifest.encrypted === undefined ? {} : { encrypted: { kind: 'pdf', locked: true } }),
  });
  if (
    !view.success ||
    view.data.id !== folderId ||
    view.data.id !== `att_${view.data.sha256}` ||
    !SAFE_FILENAME.test(view.data.filename) ||
    view.data.filename === '.' ||
    view.data.filename === '..'
  )
    return undefined;
  return {
    id: view.data.id,
    filename: view.data.filename,
    mime: view.data.mime,
    size: view.data.size,
    sha256: view.data.sha256,
    createdAt: view.data.createdAt,
    ...(manifest.encrypted === undefined ? {} : { encrypted: { kind: 'pdf' as const } }),
  };
}

/** A v4 render meta in v5's words: only the author's `sessionId` becomes `ferret`. */
export function v5RenderMetaDocument(meta: V4RenderMeta): unknown {
  const { author, ...rest } = meta;
  return { ...rest, author: author.sessionId === undefined ? {} : { ferret: author.sessionId } };
}

const ENDED = new Set(['completed', 'failed', 'stalled', 'stopped', 'interrupted']);

export const conversationStep: Step = {
  id: 'conversation',
  title:
    'Conversation (queue, sends, answers, inbox/outbox, question, drafts, turns, links, attachments, renders, key)',
  owner: ['plugin-conversation'],
  reads: [
    'state/sessions/<sid>/turns/',
    'state/sessions/<sid>/channel/{queue,sends,answers,inbox,outbox}.jsonl',
    'state/sessions/<sid>/question-asked.json (live ferrets; mtime is askedAt)',
    'state/sessions/<sid>/config.json (transcript: links, the question’s transcript)',
    'fleet/ids.json (where a transcript lands in the new home)',
    'state/shared-drafts/<sid>.json, <sid>.items/<askId>.json',
    'state/attachments/<daemonId>/<sid>/<attachmentId>/manifest.json (original never opened)',
    'state/renders/<shard>/<id>.json (payload never opened)',
  ],
  sealed: ['state/session-message-token.key'],
  notCarried: [
    { what: 'search and finder caches', why: 'v5 rebuilds them' },
    { what: 'last-snapshot.txt', why: 'the final pane frame of an ended ferret; no v5 file holds it' },
    { what: 'question-asked.json of ended ferrets', why: 'it describes a form that is gone' },
    {
      what: 'question-asked.json that v5’s question writer would not store',
      why: 'several questions at once, another transcript than the ferret’s, or a question v5 refuses: v5 clears such a file and reads the question from the transcript',
    },
    {
      what: 'channel/queued-<sendId>.md and .by.json, and each send’s payloadFile pointer',
      why: 'v5 declares no state for queued payloads (its turn port’s writeQueuedPayload has no store) and never reads payloadFile; the message itself is carried in the send and queue lines',
    },
    {
      what: 'send-ledger timers opportunityAt, unaccountedDeadline, hardDeadline, timeoutFrozenAt',
      why: 'v5’s send record has no such fields and nothing in v5 reads them',
    },
    {
      what: 'outbox lines of type question (a ferret asking for help)',
      why: 'v5 writes those into the Ferrets session folder, not Conversation’s outbox, which holds only messages',
    },
    { what: 'media/', why: 'no v5 state declaration' },
    {
      what: 'shared drafts and attachments of sessions with no config.json',
      why: 'they belong to no ferret',
    },
    {
      what: 'an attachment original with no manifest, and a render payload with no meta',
      why: 'an upload or save cut short (the meta is written last); v4 and v5 both read it as nothing',
    },
    {
      what: 'a second copy of one attachment under another <daemonId>',
      why: 'attachment ids are content addresses, so it is the same file; the first is kept',
    },
    { what: 'links inside turns/', why: 'never followed or re-made' },
    {
      what: 'a final log line with no newline that does not parse',
      why: 'a crash during the v4 append; v4 itself skipped it',
    },
  ],
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: this.id, title: this.title, notCarried: this.notCarried };
    const reader: V4Reader = { home: ctx.v4.home };
    const label = (path: string) => path.slice(ctx.v4.home.length + 1);
    try {
      const sealed: { file: string; bytes: number }[] = [];
      const counts = {
        turnFiles: 0,
        turnLinks: 0,
        chatDrafts: 0,
        itemDrafts: 0,
        orphanDrafts: 0,
        links: 0,
        queueLines: 0,
        queued: 0,
        sendLines: 0,
        sends: 0,
        payloadPointers: 0,
        answerLines: 0,
        answers: 0,
        inbox: 0,
        outbox: 0,
        outboxQuestions: 0,
        questions: 0,
        questionsDropped: 0,
        attachments: 0,
        orphanAttachments: 0,
        tornAttachments: 0,
        duplicateAttachments: 0,
        renders: 0,
        tornRenders: 0,
        missingOriginals: [] as string[],
        damaged: [] as string[],
      };
      /** One damaged v4 record: counted and named (path or `file line N`, never content), not carried. */
      const damage = (problem: string, where: string): void => {
        counts.damaged.push(`${problem}: ${where}`);
      };
      /** A record read that fails as `V4InputError` (torn, not JSON, wrong shape) is damage, not a failed step. */
      const damagedAs = async <T>(where: string, read: () => Promise<T>): Promise<T | 'damaged'> => {
        try {
          return await read();
        } catch (error) {
          if (!(error instanceof V4InputError)) throw error;
          // The error's own file is the real path (with the daemon id); the masked name is the one shown.
          damage(error.message.split(': ')[0] ?? 'v4 record is damaged', where);
          return 'damaged';
        }
      };

      // The key: metadata only (lstat), then moved unopened. v4 refused a key that was not 0600, and so would v5.
      const key = join(ctx.v4.state, V4_MESSAGE_TOKEN_KEY);
      const keyInfo = await entry(key);
      if (keyInfo !== undefined) {
        if (!keyInfo.isFile())
          throw new V4InputError('sealed key is not a regular file', `state/${V4_MESSAGE_TOKEN_KEY}`);
        if ((keyInfo.mode & 0o777) !== V4_MESSAGE_TOKEN_KEY_MODE)
          throw new V4InputError('sealed key is not mode 0600', `state/${V4_MESSAGE_TOKEN_KEY}`);
        if (!ctx.dryRun) await moveSealed(key, ctx.v5.resolve(V5_MESSAGE_TOKEN_KEY_FILE));
        sealed.push({ file: V5_MESSAGE_TOKEN_KEY_FILE, bytes: keyInfo.size });
      }

      const copyTree = async (from: string, to: string): Promise<void> => {
        const source = await entry(from);
        if (source === undefined) return;
        if (source.isSymbolicLink()) {
          counts.turnLinks++;
          return;
        }
        if (source.isDirectory()) {
          if (!ctx.dryRun) await mkdir(ctx.v5.resolve(to), { recursive: true, mode: 0o700 });
          for (const name of (await readdir(from)).sort()) await copyTree(join(from, name), join(to, name));
          if (!ctx.dryRun) {
            await chmod(ctx.v5.resolve(to), source.mode & 0o777);
            await utimes(ctx.v5.resolve(to), source.atime, source.mtime);
          }
          return;
        }
        if (!source.isFile()) {
          damage('turn entry is not a file or folder', label(from));
          return;
        }
        if (!ctx.dryRun) await moveSealed(from, ctx.v5.resolve(to));
        counts.turnFiles++;
      };

      /**
       * One v4 log, line for line, into its v5 file. `map` answers the v5 line, or `undefined` for a line v5 keeps
       * nowhere. A line v5 would refuse (its schema, or the kernel's line bound) fails the step by file and line.
       */
      const convertLog = async <V4, V5>(
        from: string,
        v4Schema: z.ZodType<V4>,
        map: (line: V4) => unknown,
        v5Schema: z.ZodType<V5>,
        to: string,
        check: (line: V5) => boolean = () => true,
      ): Promise<{ v4: readonly V4[]; written: number; skipped: number }> => {
        const read = await damagedAs(label(from), () => readJsonlLines(reader, from, v4Schema));
        // A log that cannot be read at all is one damaged record: named, nothing carried from it.
        const lines = read === 'damaged' ? [] : read;
        const out: V5[] = [];
        let skipped = 0;
        for (const { line, value } of lines) {
          const mapped = map(value);
          if (mapped === undefined) {
            skipped++;
            continue;
          }
          const parsed = v5Schema.safeParse(mapped);
          if (!parsed.success || !check(parsed.data)) {
            damage(`v4 log line ${line} has no v5 form`, label(from));
            continue;
          }
          if (Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > V5_MAX_JSONL_LINE_BYTES) {
            damage(`v4 log line ${line} is longer than a v5 line may be`, label(from));
            continue;
          }
          out.push(parsed.data);
        }
        if (out.length > 0) await ctx.v5.jsonl({ path: to, format: 1, schema: v5Schema }, out);
        return { v4: lines.map(line => line.value), written: out.length, skipped };
      };

      const sessions = await configs(ctx.v4.sessions);
      const known = new Set(sessions.map(config => config.id));
      const links: z.input<typeof LinksFileSchema>['links'] = [];
      const draftsFolder = sharedDraftsFolder(ctx.v4.state);
      let ids: Awaited<ReturnType<typeof runtimeIds>> | null = null;
      const v5TranscriptOf = async (config: V4Config): Promise<string | undefined> => {
        if (config.transcript === undefined) return undefined;
        ids ??= await runtimeIds(ctx.v4.fleet);
        return rewriteTranscript(ctx, config.harness, config.transcript, ids)?.file;
      };

      for (const config of sessions) {
        const folder = join(ctx.v4.sessions, config.id);
        const channel = join(folder, 'channel');
        const state = await json(join(folder, 'state.json'), State);
        const ended = state === undefined || ENDED.has(state.status);

        // Turns: opaque, byte for byte.
        const turns = join(folder, 'turns');
        const turnsInfo = await entry(turns);
        if (turnsInfo !== undefined) {
          if (!turnsInfo.isDirectory()) damage('turns is not a folder', `state/sessions/${config.id}/turns`);
          else await copyTree(turns, v5TurnsFolder(config.id));
        }

        // The chat draft, through v5's own snapshot schema.
        const chatWhere = `state/shared-drafts/${config.id}.json`;
        const chatRead = await damagedAs(chatWhere, () =>
          readJson(reader, join(draftsFolder, `${config.id}.json`), V4SharedDraft),
        );
        let chat = chatRead === 'damaged' ? undefined : chatRead;
        if (chat !== undefined && (chat.sessionId !== config.id || chat.slot !== undefined)) {
          damage('shared draft names another session or slot', chatWhere);
          chat = undefined;
        }
        // Agenda reply drafts, keyed by the ask id. v5 Asks numbers asks per ferret exactly as v4 did (the agenda
        // files are carried with their ids), so `A<n>` on this ferret's board is the same ask in v5.
        const items: Record<string, z.input<typeof DraftSnapshotSchema>> = {};
        const itemsFolder = join(draftsFolder, `${config.id}.items`);
        for (const item of await names(reader, itemsFolder)) {
          if (item.folder || !item.name.endsWith('.json')) continue;
          const slot = item.name.slice(0, -'.json'.length);
          if (!V4AgendaId.safeParse(slot).success) continue;
          const itemWhere = `state/shared-drafts/${config.id}.items/${item.name}`;
          const draft = await damagedAs(itemWhere, () => readJson(reader, join(itemsFolder, item.name), V4SharedDraft));
          if (draft === undefined || draft === 'damaged') continue;
          if (draft.sessionId !== config.id || draft.slot !== slot) {
            damage('agenda draft names another session or slot', itemWhere);
            continue;
          }
          const { sessionId, ...rest } = draft;
          items[slot] = DraftSnapshotSchema.parse({ ...rest, ferret: sessionId });
          counts.itemDrafts++;
        }
        if (chat !== undefined || Object.keys(items).length > 0) {
          const document = DraftsDocumentSchema.parse({
            ...(chat === undefined
              ? {}
              : (({ sessionId, slot: _slot, ...rest }) => ({
                  chat: DraftSnapshotSchema.parse({ ...rest, ferret: sessionId }),
                }))(chat)),
            items,
          });
          await ctx.v5.json({ path: v5DraftsFile(config.id), format: 1, schema: DraftsDocumentSchema }, document);
          if (chat !== undefined) counts.chatDrafts++;
        }

        // Links: a kept (adopted) conversation is read where its harness keeps it.
        const transcript = config.transcript;
        if (transcript?.identity === 'adopted' && transcript.harnessSessionId !== undefined)
          links.push({
            id: transcript.harnessSessionId,
            harness: config.harness === 'claude' ? 'claude-code' : 'codex',
            ferret: config.id,
            linkedAt: transcript.resolvedAt ?? config.createdAt,
          });

        // The logs, line for line.
        const queue = await convertLog(
          join(channel, 'queue.jsonl'),
          V4QueueEvent,
          event => ({ format: 1, ...event }),
          V5QueueLineSchema,
          v5QueueFile(config.id),
        );
        counts.queueLines += queue.written;
        counts.queued += foldV4Queue(queue.v4).length;

        const sends = await convertLog(
          join(channel, 'sends.jsonl'),
          V4SendLine,
          v5SendLine,
          V5SendLineSchema,
          v5SendsFile(config.id),
          line => SendRecordSchema.safeParse(v5SendView(line)).success,
        );
        counts.sendLines += sends.written;
        counts.sends += latestV4Sends(sends.v4).length;
        counts.payloadPointers += sends.v4.filter(line => line.payloadFile !== undefined).length;

        const answers = await convertLog(
          join(channel, 'answers.jsonl'),
          V4AnswerReceipt,
          receipt => ({ format: 1, ...receipt }),
          V5AnswerLineSchema,
          v5AnswersFile(config.id),
        );
        counts.answerLines += answers.written;
        counts.answers += latestV4Answers(answers.v4).length;

        const inbox = await convertLog(
          join(channel, 'inbox.jsonl'),
          V4InboxLine,
          line => ({ format: 1, ...line }),
          V5InboxLineSchema,
          v5InboxFile(config.id),
        );
        counts.inbox += inbox.written;

        const outbox = await convertLog(
          join(channel, 'outbox.jsonl'),
          V4OutboxLine,
          line => (line.type === 'question' && !('to' in line) ? undefined : { format: 1, ...line }),
          V5OutboxLineSchema,
          v5OutboxFile(config.id),
        );
        counts.outbox += outbox.written;
        counts.outboxQuestions += outbox.skipped;

        // The open question: a live ferret's only; v4 replaced the file whole per question, so its mtime is askedAt.
        if (!ended) {
          const path = join(folder, 'question-asked.json');
          const askedRead = await damagedAs(`state/sessions/${config.id}/question-asked.json`, () =>
            readJson(reader, path, V4AskedQuestion),
          );
          const asked = askedRead === 'damaged' ? undefined : askedRead;
          const askedInfo = asked === undefined ? undefined : await entry(path);
          if (asked !== undefined && askedInfo !== undefined) {
            const question = v5Question(asked, askedInfo.mtime, transcript?.file, await v5TranscriptOf(config));
            if (question === undefined) counts.questionsDropped++;
            else {
              await ctx.v5.json({ path: v5QuestionFile(config.id), format: 1, schema: QuestionSchema }, question);
              counts.questions++;
            }
          }
        }
      }

      for (const item of await names(reader, draftsFolder))
        if (!item.folder && item.name.endsWith('.json') && !known.has(item.name.slice(0, -'.json'.length)))
          counts.orphanDrafts++;

      if (links.length > 0) {
        const document = LinksFileSchema.parse({ format: 1, links });
        await ctx.v5.json({ path: V5_LINKS_FILE, format: 1, schema: LinksFileSchema }, document);
        counts.links = document.links.length;
      }

      // Attachments: the original moved unopened, the manifest re-encoded as v5's store writes it. The <daemonId>
      // segment (v4's pairing identity) has no v5 counterpart: v5 keys an attachment by ferret and id only.
      const attachments = join(ctx.v4.state, 'attachments');
      const carried = new Set<string>();
      for (const daemon of await names(reader, attachments)) {
        if (!daemon.folder) continue;
        for (const session of await names(reader, join(attachments, daemon.name))) {
          if (!session.folder) continue;
          for (const attachment of await names(reader, join(attachments, daemon.name, session.name))) {
            if (!attachment.folder) continue;
            const where = join(attachments, daemon.name, session.name, attachment.name);
            const named = `state/attachments/<daemonId>/${session.name}/${attachment.name}`;
            const manifest = await damagedAs(named, () =>
              readJson(reader, join(where, 'manifest.json'), V4AttachmentManifest),
            );
            if (manifest === 'damaged') continue;
            const original = await entry(join(where, 'original'));
            if (manifest === undefined) {
              if (original !== undefined) counts.tornAttachments++;
              continue;
            }
            // Damage in ONE record never fails the step: it is counted and named, and nothing is carried for it.
            if (manifest.id !== attachment.name) {
              damage('attachment manifest names another id', named);
              continue;
            }
            if (!original?.isFile()) {
              counts.missingOriginals.push(named);
              continue;
            }
            if (!known.has(session.name)) {
              counts.orphanAttachments++;
              continue;
            }
            const document = v5AttachmentManifestDocument(manifest, attachment.name);
            if (document === undefined) {
              damage('attachment manifest has no v5 form', named);
              continue;
            }
            const name = `${session.name}~${document.id}`;
            if (carried.has(name)) {
              counts.duplicateAttachments++;
              continue;
            }
            carried.add(name);
            // The original first and the manifest last, as v5's store publishes one.
            if (!ctx.dryRun)
              await moveSealed(
                join(where, 'original'),
                ctx.v5.resolve(v5AttachmentOriginal(session.name, document.id)),
              );
            await ctx.v5.opaque(v5AttachmentManifest(session.name, document.id), `${JSON.stringify(document)}\n`);
            counts.attachments++;
          }
        }
      }

      // Renders: the meta through `StoredRenderMetaSchema` (the kernel stamps `format`), the payload moved unopened.
      const renders = join(ctx.v4.state, 'renders');
      for (const shard of await names(reader, renders)) {
        if (!shard.folder) continue;
        const files = await names(reader, join(renders, shard.name));
        const metas = new Set(files.filter(file => !file.folder && file.name.endsWith('.json')).map(file => file.name));
        for (const file of files) {
          if (file.folder) continue;
          if (file.name.endsWith('.payload')) {
            if (!metas.has(`${file.name.slice(0, -'.payload'.length)}.json`)) counts.tornRenders++;
            continue;
          }
          if (!file.name.endsWith('.json')) continue;
          const id = file.name.slice(0, -'.json'.length);
          const named = `state/renders/${shard.name}/${file.name}`;
          const meta = await damagedAs(named, () =>
            readJson(reader, join(renders, shard.name, file.name), V4RenderMeta),
          );
          if (meta === undefined || meta === 'damaged') continue;
          if (meta.id !== id || id.slice(0, 2) !== shard.name) {
            damage('render meta names another id or shard', named);
            continue;
          }
          const payload = join(renders, shard.name, `${id}.payload`);
          if (!(await entry(payload))?.isFile()) {
            damage('render has no payload file', named);
            continue;
          }
          const document = StoredRenderMetaSchema.safeParse(v5RenderMetaDocument(meta));
          if (!document.success) {
            damage('render meta has no v5 form', named);
            continue;
          }
          if (!ctx.dryRun) await moveSealed(payload, ctx.v5.resolve(v5RenderPayload(id)));
          await ctx.v5.stamped({ path: v5RenderMeta(id), format: 1, schema: StoredRenderMetaSchema }, document.data);
          counts.renders++;
        }
      }

      const kept: KeptItem[] = [
        { what: 'message-token keys moved unopened', count: sealed.length },
        { what: 'turn files copied byte for byte', count: counts.turnFiles },
        { what: 'chat drafts', count: counts.chatDrafts },
        { what: 'agenda reply drafts', count: counts.itemDrafts },
        { what: 'conversation links', count: counts.links },
        { what: 'queue events', count: counts.queueLines },
        { what: 'queued messages (folded)', count: counts.queued },
        { what: 'send ledger lines', count: counts.sendLines },
        { what: 'sends (latest per send)', count: counts.sends },
        { what: 'answer receipt lines', count: counts.answerLines },
        { what: 'answer receipts (latest per request)', count: counts.answers },
        { what: 'inbox lines', count: counts.inbox },
        { what: 'outbox lines', count: counts.outbox },
        { what: 'open questions', count: counts.questions },
        { what: 'attachments (original moved unopened)', count: counts.attachments },
        { what: 'renders (payload moved unopened)', count: counts.renders },
      ];
      const omitted = [
        [counts.turnLinks, 'link(s) in turns omitted'],
        [counts.orphanDrafts, 'orphan draft(s) omitted'],
        [counts.payloadPointers, 'send payloadFile pointer(s) dropped'],
        [counts.outboxQuestions, 'outbox question line(s) left to Ferrets'],
        [counts.questionsDropped, 'open question(s) v5 would not store (the transcript answers instead)'],
        [counts.orphanAttachments, 'attachment(s) of no ferret omitted'],
        [counts.tornAttachments, 'attachment original(s) with no manifest omitted'],
        [counts.duplicateAttachments, 'duplicate attachment(s) under another daemon id omitted'],
        [counts.tornRenders, 'render payload(s) with no meta omitted'],
      ] as const;
      const notes = omitted.filter(([count]) => count > 0).map(([count, what]) => `${count} ${what}`);
      if (counts.missingOriginals.length > 0)
        notes.push(
          `${counts.missingOriginals.length} attachments with no original file (not carried; v5 keeps no manifest without its original): ${counts.missingOriginals.join(', ')}`,
        );
      if (counts.damaged.length > 0)
        notes.push(`${counts.damaged.length} damaged v4 record(s) not carried: ${counts.damaged.join('; ')}`);
      if (ctx.dryRun) notes.push('dry run: nothing written');
      return {
        ...base,
        status: 'converted',
        ...(notes.length === 0 ? {} : { note: notes.join('; ') }),
        kept,
        sealed,
      };
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note:
          error instanceof V4InputError
            ? error.message
            : 'cannot convert conversation input: invalid data or an unavailable file',
        kept: [],
        sealed: [],
      };
    }
  },
};
