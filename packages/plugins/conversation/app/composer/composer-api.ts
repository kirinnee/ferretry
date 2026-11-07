/**
 * WHAT THE COMPOSER ASKS OF THE DAEMON, over the half's one client (§9.6): send a message, act on the text stuck in
 * the agent's own box, and finish a send that was typed but never shown. Today these were five methods of the
 * protocol's API client; they are the same five calls by route key here, with the answers parsed by the contract's
 * schemas exactly as today.
 *
 * A send keeps today's FAILED-SEND MEMORY: a message whose send failed — for any reason — goes again under the SAME
 * request id for ten minutes, so a lost answer after the daemon accepted it never makes the agent read it twice. The
 * id travels as the body's `sendId`, the daemon's idempotency key.
 */
import {
  type ComposerResult,
  ComposerResultSchema,
  type SendRecord,
  SendRecordSchema,
  type SendRequest,
  type SendResult,
  SendResultSchema,
} from '../../contract/index.ts';
import type { ConversationCaller } from './seam.ts';

/** How long a failed send's request id is reused for the same words. */
const FAILED_SEND_MEMORY_MS = 10 * 60_000;
/** How many failed sends are remembered at once. */
const FAILED_SEND_MEMORY_LIMIT = 32;

/** The composer's body for one send: the request minus the id, which {@link ComposerApi.send} owns. */
type ComposerSendInput = Omit<SendRequest, 'sendId'>;

/** The five calls a composer makes; a host may hand in its own (a reply that names Agenda items, a test). */
export interface ComposerApi {
  send(ferretId: string, input: ComposerSendInput, requestId?: string): Promise<SendResult>;
  /** "Send it" / "Clear it" on the person's own text the agent's box still holds (`POST …/composer`, G33). */
  resolveComposerDraft?(
    ferretId: string,
    request: { readonly action: 'submit' | 'clear'; readonly draft: string },
  ): Promise<ComposerResult>;
  submitSend?(ferretId: string, sendId: string): Promise<SendRecord>;
  cancelSend?(ferretId: string, sendId: string): Promise<SendRecord>;
  retrySend?(ferretId: string, sendId: string, force?: boolean): Promise<SendRecord>;
}

class FailedSendMemory {
  readonly #entries = new Map<string, { readonly requestId: string; readonly at: number }>();

  constructor(private readonly nowMs: () => number) {}

  recall(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.nowMs() - entry.at <= FAILED_SEND_MEMORY_MS) return entry.requestId;
    this.#entries.delete(key);
    return undefined;
  }

  remember(key: string, requestId: string): void {
    this.#entries.delete(key);
    this.#entries.set(key, { requestId, at: this.nowMs() });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= FAILED_SEND_MEMORY_LIMIT) break;
      this.#entries.delete(oldest);
    }
  }

  forget(key: string): void {
    this.#entries.delete(key);
  }
}

const failedSendKey = (ferretId: string, input: ComposerSendInput): string =>
  JSON.stringify([ferretId, input.message, [...(input.attachmentIds ?? [])].sort()]);

const defaultRequestId = (): string => globalThis.crypto.randomUUID();

const requireValue = (value: string, what: string): string => {
  if (value.trim() === '') throw new TypeError(`${what} must not be empty`);
  return value;
};

/** The composer's calls over the plugin client. */
export function composerApi(
  client: ConversationCaller,
  options: { readonly nowMs?: () => number; readonly requestId?: () => string } = {},
): Required<ComposerApi> {
  const failed = new FailedSendMemory(options.nowMs ?? Date.now);
  const newRequestId = options.requestId ?? defaultRequestId;
  const sendRoute = (ferretId: string, sendId: string, action: 'enter' | 'cancel' | 'retry', body: object) =>
    client
      .call(`POST /v1/ferrets/:ferretId/sends/:sendId/${action}`, {
        params: { ferretId: requireValue(ferretId, 'ferretId'), sendId: requireValue(sendId, 'sendId') },
        body,
      })
      .then(answer => SendRecordSchema.parse(answer));
  return {
    async send(ferretId, input, requestId) {
      const key = failedSendKey(ferretId, input);
      const logical = requireValue(requestId ?? failed.recall(key) ?? newRequestId(), 'request id');
      try {
        const answer = await client.call('POST /v1/ferrets/:ferretId/send', {
          params: { ferretId: requireValue(ferretId, 'ferretId') },
          body: { ...input, sendId: logical } satisfies SendRequest,
        });
        failed.forget(key);
        return SendResultSchema.parse(answer);
      } catch (error) {
        // ANY failure is remembered, not only a lost answer: a refusal before acceptance left no record, so reusing
        // its id costs nothing, while a lost answer after acceptance is exactly the case where a fresh id would make
        // the agent read the message twice.
        failed.remember(key, logical);
        throw error;
      }
    },
    async resolveComposerDraft(ferretId, request) {
      const answer = await client.call('POST /v1/ferrets/:ferretId/composer', {
        params: { ferretId: requireValue(ferretId, 'ferretId') },
        body: request,
      });
      return ComposerResultSchema.parse(answer);
    },
    submitSend: (ferretId, sendId) => sendRoute(ferretId, sendId, 'enter', {}),
    cancelSend: (ferretId, sendId) => sendRoute(ferretId, sendId, 'cancel', {}),
    retrySend: (ferretId, sendId, force) => sendRoute(ferretId, sendId, 'retry', force === true ? { force: true } : {}),
  };
}
