import type { PluginClient } from '@ferretry/kernel/manifest';
import {
  type AnswerRequest,
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

/** Speaks the conversation routes through the plugin client; replies are parsed against the contract. */
export class ClientConversationGateway implements SendGateway, AnswerGateway, CompactAtGateway {
  constructor(private readonly client: Pick<PluginClient, 'call'>) {}

  async send(ferret: string, request: SendRequest): Promise<SendResult> {
    return SendResultSchema.parse(await this.client.call(ROUTES.send, { ...at(ferret), body: request }));
  }

  async sendStatus(ferret: string, sendId: string): Promise<SendRecord | undefined> {
    try {
      return SendRecordSchema.parse(await this.client.call(ROUTES.sendStatus, at(ferret, { sendId })));
    } catch (error) {
      // A message still in Ferretry's queue has no ledger row yet: that is waiting, not a missing send.
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

  async answer(ferret: string, request: AnswerRequest): Promise<void> {
    await this.client.call(ROUTES.answer, { ...at(ferret), body: request });
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
