import { randomUUID } from 'node:crypto';
import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type AnswerRequest,
  AskedQuestionViewSchema,
  type Question,
  type CompactAtPatch,
  CompactAtPatchResultSchema,
  type FerretCompactAt,
  FerretCompactAtSchema,
  type SendRecord,
  SendRecordSchema,
  type SendRequest,
  type SendResult,
  SendResultSchema,
} from '../../contract/index.ts';
import { CommandError } from './errors.ts';
import type { AnswerGateway } from './answer/controller.ts';
import type { CompactAtGateway } from './compact-at/controller.ts';
import type { SendGateway, UploadedAttachment } from './send/ports.ts';

const ROUTES = {
  send: 'POST /v1/ferrets/:ferretId/send',
  sendStatus: 'GET /v1/ferrets/:ferretId/sends/:sendId',
  interrupt: 'POST /v1/ferrets/:ferretId/interrupt',
  question: 'GET /v1/ferrets/:ferretId/question',
  answer: 'POST /v1/ferrets/:ferretId/answer',
  compactAt: 'GET /v1/ferrets/:ferretId/compact-at',
  setCompactAt: 'PATCH /v1/ferrets/:ferretId/compact-at',
  /** Ferrets' route: parking a ferret on a reply is its lifecycle signal, not a conversation act. */
  signal: 'POST /v1/ferrets/:ferretId/signal',
} as const;

const at = (ferret: string, extra: Readonly<Record<string, string>> = {}) => ({
  params: { ferretId: ferret, ...extra },
});

/** Why a verb that needs a local file cannot have one: the shell hands a verb no file access. */
export const NO_FILE_ACCESS =
  'this verb cannot read local files yet: the shell gives a plugin no file access. Put the words in the message itself';

/** The one header a half may set (PluginCallHeaders); the shell forwards it. */
const requestIdHeader = (id: string) => ({ 'x-fy-request-id': id });

/**
 * Speaks the conversation routes through the plugin client; replies are parsed against the contract.
 *
 * A send and an answer are each refused (`missing_request_id`) without `x-fy-request-id`: a retried POST without it
 * would reach the agent twice. The send's key is also its body `sendId` (the daemon refuses two different ones), so a
 * caller that already chose one keeps it and a retry under that id is the same message.
 */
export class ClientConversationGateway implements SendGateway, AnswerGateway, CompactAtGateway {
  constructor(
    private readonly client: Pick<PluginClient, 'call'>,
    private readonly mintRequestId: () => string = randomUUID,
  ) {}

  async send(ferret: string, request: SendRequest): Promise<SendResult> {
    const sendId = request.sendId ?? this.mintRequestId();
    return SendResultSchema.parse(
      await this.client.call(ROUTES.send, {
        ...at(ferret),
        body: { ...request, sendId },
        headers: requestIdHeader(sendId),
      }),
    );
  }

  async sendStatus(ferret: string, sendId: string, waitMs?: number): Promise<SendRecord | undefined> {
    try {
      return SendRecordSchema.parse(
        await this.client.call(ROUTES.sendStatus, {
          ...at(ferret, { sendId }),
          ...(waitMs === undefined ? {} : { query: { waitMs: String(waitMs) } }),
        }),
      );
    } catch (error) {
      // A message still in Ferretry's queue has a record of its own; a 404 is a send the daemon does not know.
      if ((error as { status?: unknown }).status === 404) return undefined;
      throw error;
    }
  }

  async upload(_ferret: string, _file: string): Promise<UploadedAttachment> {
    throw new CommandError(NO_FILE_ACCESS);
  }

  async parkUntilReply(
    caller: string,
    options: { readonly peer: string; readonly until?: string; readonly condition: string },
  ): Promise<void> {
    await this.client.call(ROUTES.signal, { ...at(caller), body: { kind: 'waiting', ...options } });
  }

  async question(ferret: string): Promise<Question | undefined> {
    return AskedQuestionViewSchema.parse(await this.client.call(ROUTES.question, at(ferret))).question ?? undefined;
  }

  async answer(ferret: string, request: AnswerRequest): Promise<void> {
    await this.client.call(ROUTES.answer, {
      ...at(ferret),
      body: request,
      headers: requestIdHeader(this.mintRequestId()),
    });
  }

  async interrupt(ferret: string): Promise<void> {
    await this.client.call(ROUTES.interrupt, { ...at(ferret), body: {} });
  }

  async read(ferret: string): Promise<FerretCompactAt> {
    return FerretCompactAtSchema.parse(await this.client.call(ROUTES.compactAt, at(ferret)));
  }

  async write(ferret: string, change: CompactAtPatch) {
    return CompactAtPatchResultSchema.parse(
      await this.client.call(ROUTES.setCompactAt, { ...at(ferret), body: change }),
    );
  }
}
