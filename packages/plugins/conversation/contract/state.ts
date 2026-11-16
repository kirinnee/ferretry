import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { StoredRenderMetaSchema } from './wire-media.ts';
import { FinderFileSchema, LinksFileSchema } from './wire-link.ts';
import { QuestionSchema } from './wire-question.ts';
import { PromptWaitRecordSchema } from './wire-prompt.ts';
import { SegmentMessageSchema } from './lines.ts';

/** An opaque or secret file is bytes the kernel never parses: the schema types the port, it checks nothing. */
const BYTES = z.instanceof(Uint8Array);

/**
 * The files under `state/conversation/` (§9.2). `*` is the ferret's folder. Every JSON document starts at format 1;
 * a queue line carries its own `v: 1`; the other JSONL files (sends, answers, inbox,
 * outbox) are written without one, and the schema of each line is in `lines.ts`. A damaged file fails the whole plugin closed, except the two caches, which
 * are dropped and rebuilt (a cache rule).
 */
/** Lines are the queue's own events (`QueueEventSchema`), parsed at the boundary; the fold is `QueuedMessageSchema`. */
export const QUEUE_STATE = defineState({ name: 'queue', path: '*/queue.jsonl', store: 'jsonl', format: 1 });
/**
 * A queue SHARD: the FINAL messages (`read`, `cancelled`, `failed`) of one rotated-away stretch of a ferret's queue,
 * sealed and never written again. `queue-shards/<ferret>~<through>.json`, `through` the position the rotation reached
 * (the next live segment's `base`), zero-padded to twelve digits so names sort. A shard is written BEFORE the live file
 * is replaced, so a reader uses only shards whose `through` is not past the live `base`: one that is past it is a rotation
 * that did not finish, and the next rotation rewrites or removes it.
 */
export const QueueShardSchema = z.strictObject({
  format: z.literal(1),
  through: z.number().int().positive(),
  messages: z.array(SegmentMessageSchema),
});
export type QueueShard = z.infer<typeof QueueShardSchema>;
export const QUEUE_SHARD_STATE = defineState({
  name: 'queue-shard',
  path: 'queue-shards/*.json',
  store: 'json',
  format: 1,
  schema: QueueShardSchema,
});
/**
 * The OPEN messages a rotation carried into a live segment: `queue-carry/<ferret>~<base>.json`, `base` the live
 * segment's header `base` and the only carry file it reads. A document rather than records of `queue.jsonl` because a
 * record is capped (1 MiB) and the open messages together — or one long one that later gained a wait reason — can pass
 * it, which would make every rotation fail. It is written before the live file is replaced, as a shard is; one whose base
 * is not the live file's is a rotation that did not finish (or one that has been replaced) and is ignored, then removed.
 */
export const QueueCarrySchema = z.strictObject({
  format: z.literal(1),
  base: z.number().int().positive(),
  messages: z.array(SegmentMessageSchema),
});
export type QueueCarry = z.infer<typeof QueueCarrySchema>;
export const QUEUE_CARRY_STATE = defineState({
  name: 'queue-carry',
  path: 'queue-carry/*.json',
  store: 'json',
  format: 1,
  schema: QueueCarrySchema,
});
/** Lines are the ledger's own records (`SendLineSchema`), last write per send id wins; `SendRecordSchema` is the wire view of one. */
export const SENDS_STATE = defineState({ name: 'sends', path: '*/sends.jsonl', store: 'jsonl', format: 1 });
/** What reached a ferret (`InboxLineSchema`), and what it sent (`OutboxLineSchema`). */
export const INBOX_STATE = defineState({ name: 'inbox', path: '*/inbox.jsonl', store: 'jsonl', format: 1 });
export const OUTBOX_STATE = defineState({ name: 'outbox', path: '*/outbox.jsonl', store: 'jsonl', format: 1 });
/** Lines are the answer ledger's receipts (`AnswerLineSchema`), last write per request wins. */
export const ANSWERS_STATE = defineState({ name: 'answers', path: '*/answers.jsonl', store: 'jsonl', format: 1 });
export const TURNS_STATE = defineState({ name: 'turns', path: '*/turns', store: 'opaque', format: 1 });
/**
 * The screen a STUCK send met, kept so the cause can be found afterwards: `<ferret>/stuck-frame-1.txt` is the newest,
 * `-2` and `-3` the two before it, and nothing older is kept. One is written when a send is said stuck (`stuckAt`),
 * from the runner's MASKED capture, `0600`, and it stays on this machine: no route serves it and no log or message
 * carries its text — only its path is logged.
 */
const stuckFrame = (slot: 1 | 2 | 3) =>
  defineState({
    name: `stuck-frame-${slot}`,
    path: `*/stuck-frame-${slot}.txt`,
    store: 'opaque',
    format: 1,
    schema: BYTES,
    mode: 0o600,
  });
/** Newest first. */
export const STUCK_FRAME_STATES = [stuckFrame(1), stuckFrame(2), stuckFrame(3)] as const;
export const QUESTION_STATE = defineState({
  name: 'question',
  path: '*/question.json',
  store: 'json',
  format: 1,
  schema: QuestionSchema,
});
/**
 * The last question a ferret's form took an answer for (v4's `lastAnsweredQuestionToolUseId`, the one fact the answer
 * ledger's reconciliation defers to). It is stamped BEFORE `question.json` is cleared, so a crash between the two leaves
 * the answer provable rather than a form that looks unanswered; a stamp is for one question and a newer one replaces it.
 */
export const QuestionAnsweredSchema = z.strictObject({
  format: z.literal(1),
  toolUseId: z.string().min(1),
  answeredAt: z.string().min(1),
});
export type AnsweredQuestionStamp = z.infer<typeof QuestionAnsweredSchema>;
export const QUESTION_ANSWERED_STATE = defineState({
  name: 'question-answered',
  path: '*/question-answered.json',
  store: 'json',
  format: 1,
  schema: QuestionAnsweredSchema,
});
/** Where a ferret is in its waits on a permission prompt or a dialog, and the card held for it (`PromptWaitRecordSchema`). */
export const PROMPT_WAIT_STATE = defineState({
  name: 'prompt-wait',
  path: '*/prompt-wait.json',
  store: 'json',
  format: 1,
  schema: PromptWaitRecordSchema,
});
/** The hypermedia switch the owner set for one ferret; none means the mode's default (docs/hypermedia.md). */
export const HypermediaSwitchSchema = z.strictObject({
  format: z.literal(1),
  enabled: z.boolean(),
  updatedAt: z.string().min(1),
});
export const HYPERMEDIA_STATE = defineState({
  name: 'hypermedia',
  path: '*/hypermedia.json',
  store: 'json',
  format: 1,
  schema: HypermediaSwitchSchema,
});
export const DRAFTS_STATE = defineState({
  name: 'drafts',
  path: '*/drafts',
  store: 'opaque',
  format: 1,
  schema: BYTES,
});
/**
 * An attachment is two byte files, `attachments/<ferret>~<attachment id>.original` and `….manifest`: a collection,
 * which one opaque path per ferret cannot hold. `~` is in neither a ferret id nor an attachment id (`att_<hex>`), so a
 * name splits one way only. The manifest is parsed by the store, which owns what a usable one is; the original never is.
 */
export const ATTACHMENT_ORIGINAL_STATE = defineState({
  name: 'attachment-original',
  path: 'attachments/*.original',
  store: 'opaque',
  format: 1,
  schema: BYTES,
});
export const ATTACHMENT_MANIFEST_STATE = defineState({
  name: 'attachment-manifest',
  path: 'attachments/*.manifest',
  store: 'opaque',
  format: 1,
  schema: BYTES,
});
/** A render is two files: `renders/<id>.json`, its meta, and `renders/<id>.payload`, the payload text exactly as saved. */
export const RENDER_META_STATE = defineState({
  name: 'render-meta',
  path: 'renders/*.json',
  store: 'json',
  format: 1,
  schema: StoredRenderMetaSchema,
  // A meta that does not parse is not a render and is never served; it does not take the plugin down.
  onDamaged: { narrower: 'a render whose meta does not parse is skipped: it is not served, so it grants nothing' },
});
export const RENDER_PAYLOAD_STATE = defineState({
  name: 'render-payload',
  path: 'renders/*.payload',
  store: 'opaque',
  format: 1,
  schema: BYTES,
});
export const LINKS_STATE = defineState({
  name: 'links',
  path: 'links.json',
  store: 'json',
  format: 1,
  schema: LinksFileSchema,
});
export const FINDER_STATE = defineState({
  name: 'finder',
  path: 'finder.json',
  store: 'json',
  format: 1,
  schema: FinderFileSchema,
  onDamaged: { narrower: 'a cache of where each ferret keeps its files: dropped and rebuilt, it grants nothing' },
});
export const SEARCH_STATE = defineState({
  name: 'search',
  path: 'search.sqlite',
  store: 'sqlite-cache',
  format: 1,
});
/**
 * The conversation index (shared-history design §3.3): one row per transcript file of every harness history Conversation
 * lists (the owner's own homes, each ferret's home, later the pool), so a link listing is one indexed query instead of a
 * read of every transcript. A CACHE: dropped and rebuilt when its format or layout does not match, it grants nothing and
 * holds only what the transcripts already say (it never holds a whole message; previews are cut to 120 characters).
 */
export const CONVERSATION_INDEX_STATE = defineState({
  name: 'conversation-index',
  path: 'conversation-index.sqlite',
  store: 'sqlite-cache',
  format: 1,
});
/** The key that signs a message token (G41's bounded fragments); `0600`, never read back by any route. */
export const MESSAGE_TOKEN_KEY_STATE = defineState({
  name: 'message-token-key',
  path: 'message-token.key',
  store: 'secret',
  format: 1,
  /** The kernel never parses a secret file: it hands back the bytes, and the codec checks their width itself. */
  schema: z.instanceof(Uint8Array),
  mode: 0o600,
});

export const CONVERSATION_STATE = [
  QUEUE_STATE,
  QUEUE_SHARD_STATE,
  QUEUE_CARRY_STATE,
  SENDS_STATE,
  INBOX_STATE,
  OUTBOX_STATE,
  ANSWERS_STATE,
  TURNS_STATE,
  ...STUCK_FRAME_STATES,
  QUESTION_STATE,
  QUESTION_ANSWERED_STATE,
  PROMPT_WAIT_STATE,
  HYPERMEDIA_STATE,
  DRAFTS_STATE,
  ATTACHMENT_ORIGINAL_STATE,
  ATTACHMENT_MANIFEST_STATE,
  RENDER_META_STATE,
  RENDER_PAYLOAD_STATE,
  LINKS_STATE,
  FINDER_STATE,
  SEARCH_STATE,
  CONVERSATION_INDEX_STATE,
  MESSAGE_TOKEN_KEY_STATE,
] as const;

/**
 * `config/conversation.yaml`. `keepInSync`: whether every open screen of one ferret edits one shared draft (today's
 * shared draft is always on; the switch is new in §9.2's "keep in sync"). Nothing here widens authority or spend.
 */
export const ConversationConfigSchema = z.strictObject({
  keepInSync: z.boolean().default(true),
});
export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;

export const CONVERSATION_CONFIG = defineConfig({
  file: 'conversation.yaml',
  schema: ConversationConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
}) as ConfigDef;
