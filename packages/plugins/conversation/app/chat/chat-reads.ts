/**
 * WHAT THE CHAT READS AND DOES, through the half's one client (§9.6): the ferret's view, the transcript's pages, the
 * send ledger, the durable queue, a hand-off document, a transcript picture, and a ledger row's Retry, Cancel and
 * Press Enter. Every answer is parsed with the contract's schema at this edge (parse, don't validate), so nothing
 * below here trusts a daemon's shape. Today's `IFyApiClient` methods, by route key.
 *
 * R265 — THE VALIDATOR MEMORY. The chat reads a ferret's transcript tail every few seconds, and a quiet ferret
 * answers the same text each time: hundreds of kilobytes on a metered relay for nothing. So the last page each read
 * path answered is held with its `etag`, and the next read of THAT path sends `If-None-Match` and takes a bodyless
 * `304` instead. In memory and per client, which is per daemon: nothing here outlives the page or reaches another
 * daemon. Bounded (16 paths) and least-recently-used, keyed by the exact read path. A `304` to a read that sent no
 * validator has no body it could stand for, and is an error. The body held is the daemon's already-redacted text,
 * and its strong etag is over that redacted text, so a mask change changes the etag and the next read is whole: the
 * memory never serves text from before a mask change.
 */

import { type FerretView, FerretViewSchema } from '@ferretry/core-ferrets/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  AskedQuestionViewSchema,
  type HandoffDocument,
  HandoffDocumentSchema,
  HandoffNameSchema,
  type LogPage,
  type LogPageOptions,
  LogPageSchema,
  type Question,
  type SendRecord,
  SendListResponseSchema,
  SendRecordSchema,
  type TranscriptImageDownload,
  TranscriptImageDownloadSchema,
} from '../../contract/index.ts';
import { readFerretQueue } from '../queue/send-queue.ts';
import type { ChatReadApi } from './chat-refresh.ts';
import { readLedgerSends } from './send-ledger.ts';

/** How many transcript reads keep their validator. A few open chats each; past that the oldest re-reads whole. */
export const VALIDATED_LOG_LIMIT = 16;

/** The body a read last answered, and the `etag` that names it. */
interface ValidatedPage {
  readonly etag: string;
  readonly page: LogPage;
}

/** The last page each read path answered, least-recently-used first, at most {@link VALIDATED_LOG_LIMIT}. */
export class ValidatedLogMemory {
  readonly #entries = new Map<string, ValidatedPage>();

  recall(path: string): ValidatedPage | undefined {
    return this.#entries.get(path);
  }

  remember(path: string, entry: ValidatedPage): void {
    this.#entries.delete(path);
    this.#entries.set(path, entry);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= VALIDATED_LOG_LIMIT) break;
      this.#entries.delete(oldest);
    }
  }

  forget(path: string): void {
    this.#entries.delete(path);
  }

  /** The paths held, oldest first: what a test reads to see the bound. */
  paths(): readonly string[] {
    return [...this.#entries.keys()];
  }
}

/** One memory per client, which is per daemon: a second daemon never answers from the first one's pages. */
const memories = new WeakMap<object, ValidatedLogMemory>();
const memoryOf = (client: object): ValidatedLogMemory => {
  let memory = memories.get(client);
  if (memory === undefined) {
    memory = new ValidatedLogMemory();
    memories.set(client, memory);
  }
  return memory;
};

const LOG_PAGE = 'GET /v1/ferrets/:ferretId/log-page';

const logPageQuery = (options: LogPageOptions): Record<string, string> => ({
  ...(options.before === undefined ? {} : { before: String(options.before) }),
  ...(options.from === undefined ? {} : { from: String(options.from) }),
  ...(options.limit === undefined ? {} : { limit: String(options.limit) }),
  ...(options.file === undefined ? {} : { file: options.file }),
});

/**
 * One page of the transcript: the tail, or the page `before` a byte. The tail (no query) is read conditionally when
 * the client can (`client.conditional`); a page with a query is read whole, because the conditional read names a
 * route and its params only.
 */
export const readLogPage = async (
  client: Pick<PluginClient, 'call' | 'conditional'>,
  ferretId: string,
  options: LogPageOptions = {},
  memory: ValidatedLogMemory = memoryOf(client),
): Promise<LogPage> => {
  const query = logPageQuery(options);
  const conditional = client.conditional;
  if (Object.keys(query).length > 0 || conditional === undefined)
    return LogPageSchema.parse(await client.call(LOG_PAGE, { params: { ferretId }, query }));
  const path = `${LOG_PAGE} ${ferretId}`;
  // Captured BEFORE the request, so a read of another ferret that evicts it meanwhile cannot leave a `304` with
  // nothing to stand for.
  const held = memory.recall(path);
  const answer = await conditional.call(
    client,
    LOG_PAGE,
    { ferretId },
    held === undefined ? {} : { ifNoneMatch: held.etag },
  );
  if (answer.status === 304) {
    if (held === undefined) throw new Error('the daemon answered 304 Not Modified to a read that sent no validator');
    memory.remember(path, held);
    return held.page;
  }
  const page = LogPageSchema.parse(answer.body);
  if (answer.etag === undefined) memory.forget(path);
  else memory.remember(path, { etag: answer.etag, page });
  return page;
};

/** The ferret's view; the refresh checks it is the ferret it asked for. */
export const readFerretView = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<FerretView> =>
  FerretViewSchema.parse(await client.call('GET /v1/ferrets/:ferretId', { params: { ferretId } }));

export const readSends = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<SendRecord[]> =>
  SendListResponseSchema.parse(await client.call('GET /v1/ferrets/:ferretId/sends', { params: { ferretId } })).sends;

/** The question the ferret is waiting on, as Conversation proved it against the transcript, or null. */
export const readQuestion = async (client: Pick<PluginClient, 'call'>, ferretId: string): Promise<Question | null> =>
  AskedQuestionViewSchema.parse(await client.call('GET /v1/ferrets/:ferretId/question', { params: { ferretId } }))
    .question;

export const readHandoff = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  name: string,
): Promise<HandoffDocument> =>
  HandoffDocumentSchema.parse(
    await client.call('GET /v1/ferrets/:ferretId/handoffs/:name', {
      params: { ferretId, name: HandoffNameSchema.parse(name) },
    }),
  );

export const readTranscriptImage = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  handle: string,
): Promise<TranscriptImageDownload> =>
  TranscriptImageDownloadSchema.parse(
    await client.call('GET /v1/ferrets/:ferretId/transcript-images/:handle', { params: { ferretId, handle } }),
  );

export const retrySend = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  sendId: string,
  force?: boolean,
): Promise<SendRecord> =>
  SendRecordSchema.parse(
    await client.call('POST /v1/ferrets/:ferretId/sends/:sendId/retry', {
      params: { ferretId, sendId },
      body: force === true ? { force: true } : {},
    }),
  );

export const cancelSend = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  sendId: string,
): Promise<SendRecord> =>
  SendRecordSchema.parse(
    await client.call('POST /v1/ferrets/:ferretId/sends/:sendId/cancel', { params: { ferretId, sendId }, body: {} }),
  );

export const submitSend = async (
  client: Pick<PluginClient, 'call'>,
  ferretId: string,
  sendId: string,
): Promise<SendRecord> =>
  SendRecordSchema.parse(
    await client.call('POST /v1/ferrets/:ferretId/sends/:sendId/enter', { params: { ferretId, sendId }, body: {} }),
  );

/** The refresh's reads, bound to one client. */
export const chatReadApi = (client: Pick<PluginClient, 'call' | 'conditional'>): ChatReadApi => ({
  get: id => readFerretView(client, id),
  logPage: (id, options) => readLogPage(client, id, options),
  // The ledger is read UNPARSED and degraded field by field (`send-ledger.ts`): one unknown value never drops a row.
  sends: id => readLedgerSends(client, id),
  // The queue's window, as the queue page reads it (`queue/send-queue.ts`).
  queue: id => readFerretQueue(client, id),
});
