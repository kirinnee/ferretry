import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { StoredRenderMetaSchema } from './wire-media.ts';
import { LinksFileSchema } from './wire-link.ts';
import { QuestionSchema } from './wire-question.ts';

/**
 * The files under `state/conversation/` (§9.2). `*` is the ferret's folder. Every JSON document starts at format 1;
 * a JSONL line carries its own `v: 1`. A damaged file fails the whole plugin closed, except the two caches, which
 * are dropped and rebuilt (a cache rule).
 */
/** Lines are the queue's own events (enqueued, edited, moved, waiting); the fold is the schema, parsed at the boundary. */
export const QUEUE_STATE = defineState({ name: 'queue', path: '*/queue.jsonl', store: 'jsonl', format: 1 });
/** Lines are the ledger's own records, last write wins; `SendRecordSchema` is the wire view of one. */
export const SENDS_STATE = defineState({ name: 'sends', path: '*/sends.jsonl', store: 'jsonl', format: 1 });
/** What reached a ferret, and what it sent. */
export const INBOX_STATE = defineState({ name: 'inbox', path: '*/inbox.jsonl', store: 'jsonl', format: 1 });
export const OUTBOX_STATE = defineState({ name: 'outbox', path: '*/outbox.jsonl', store: 'jsonl', format: 1 });
/** Lines are the answer ledger's receipts, last write per request wins. */
export const ANSWERS_STATE = defineState({ name: 'answers', path: '*/answers.jsonl', store: 'jsonl', format: 1 });
export const TURNS_STATE = defineState({ name: 'turns', path: '*/turns', store: 'opaque', format: 1 });
export const QUESTION_STATE = defineState({
  name: 'question',
  path: '*/question.json',
  store: 'json',
  format: 1,
  schema: QuestionSchema,
});
export const DRAFTS_STATE = defineState({ name: 'drafts', path: '*/drafts', store: 'opaque', format: 1 });
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
});
export const ATTACHMENT_MANIFEST_STATE = defineState({
  name: 'attachment-manifest',
  path: 'attachments/*.manifest',
  store: 'opaque',
  format: 1,
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
  onDamaged: { narrower: 'a cache of where each ferret keeps its files: dropped and rebuilt, it grants nothing' },
});
export const SEARCH_STATE = defineState({
  name: 'search',
  path: 'search.sqlite',
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
  SENDS_STATE,
  INBOX_STATE,
  OUTBOX_STATE,
  ANSWERS_STATE,
  TURNS_STATE,
  QUESTION_STATE,
  DRAFTS_STATE,
  ATTACHMENT_ORIGINAL_STATE,
  ATTACHMENT_MANIFEST_STATE,
  RENDER_META_STATE,
  RENDER_PAYLOAD_STATE,
  LINKS_STATE,
  FINDER_STATE,
  SEARCH_STATE,
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
