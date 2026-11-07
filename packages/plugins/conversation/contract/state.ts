import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { LinksFileSchema } from './wire-link.ts';
import { AnswerRecordSchema, QuestionSchema } from './wire-question.ts';
import { QueuedMessageSchema, SendRecordSchema } from './wire-send.ts';

/**
 * The files under `state/conversation/` (§9.2). `*` is the ferret's folder. Every JSON document starts at format 1;
 * a JSONL line carries its own `v: 1`. A damaged file fails the whole plugin closed, except the two caches, which
 * are dropped and rebuilt (a cache rule).
 */
export const QUEUE_STATE = defineState({
  name: 'queue',
  path: '*/queue.jsonl',
  store: 'jsonl',
  format: 1,
  schema: QueuedMessageSchema,
});
export const SENDS_STATE = defineState({
  name: 'sends',
  path: '*/sends.jsonl',
  store: 'jsonl',
  format: 1,
  schema: SendRecordSchema,
});
export const ANSWERS_STATE = defineState({
  name: 'answers',
  path: '*/answers.jsonl',
  store: 'jsonl',
  format: 1,
  schema: AnswerRecordSchema,
});
export const TURNS_STATE = defineState({ name: 'turns', path: '*/turns', store: 'opaque', format: 1 });
export const QUESTION_STATE = defineState({
  name: 'question',
  path: '*/question.json',
  store: 'json',
  format: 1,
  schema: QuestionSchema,
});
export const DRAFTS_STATE = defineState({ name: 'drafts', path: '*/drafts', store: 'opaque', format: 1 });
export const ATTACHMENTS_STATE = defineState({
  name: 'attachments',
  path: '*/attachments',
  store: 'opaque',
  format: 1,
});
export const RENDERS_STATE = defineState({ name: 'renders', path: 'renders', store: 'opaque', format: 1 });
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
  mode: 0o600,
});

export const CONVERSATION_STATE = [
  QUEUE_STATE,
  SENDS_STATE,
  ANSWERS_STATE,
  TURNS_STATE,
  QUESTION_STATE,
  DRAFTS_STATE,
  ATTACHMENTS_STATE,
  RENDERS_STATE,
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
