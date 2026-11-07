import { type SessionView, SessionViewSchema } from '../../../daemon/lib/protocol/session.ts';
import {
  type ConversionPreview,
  ConversionPreviewRequestSchema,
  ConversionPreviewSchema,
  type MoveConversation,
  MoveSessionRequestSchema,
} from '../../../daemon/lib/protocol/move.ts';
import { FY_REQUEST_ID_HEADER as REQUEST_ID_HEADER } from '../../../daemon/lib/protocol/common.ts';
import type { IMoveGateway } from './ports.ts';

/**
 * The plugin client a CLI half talks through, plus the ONE thing a move needs that `PluginClient.call` does not carry
 * yet: a request header. The move route refuses a body without `x-fy-request-id` (`missing_request_id`), because a
 * retried POST without it would kill and relaunch the pane a second time. Until the kernel's `PluginClient` carries
 * headers (asked of the lead), the shell must hand this half a client that does.
 */
export interface MoveClient {
  call<Answer = unknown>(
    route: string,
    init: {
      readonly params: Readonly<Record<string, string>>;
      readonly body: unknown;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<Answer>;
}

/** Today's `FyApiClient.migrate` / `conversionPreview`, over the plugin client and the move routes. */
export class ClientMoveGateway implements IMoveGateway {
  constructor(
    private readonly client: MoveClient,
    private readonly mintRequestId: () => string,
  ) {}

  async move(
    id: string,
    agent: string,
    model?: string,
    allowContextDowngrade = false,
    requestId?: string,
    forceInflight = false,
    conversation?: MoveConversation,
  ): Promise<SessionView> {
    const body = MoveSessionRequestSchema.parse({
      agent,
      model,
      allowContextDowngrade,
      forceInflight,
      ...(conversation === undefined ? {} : { conversation }),
    });
    const answer = await this.client.call('POST /v1/ferrets/:ferretId/move', {
      params: { ferretId: id },
      body,
      headers: { [REQUEST_ID_HEADER]: requestId ?? this.mintRequestId() },
    });
    return SessionViewSchema.parse(answer);
  }

  async conversionPreview(id: string, agent: string, model?: string): Promise<ConversionPreview> {
    const body = ConversionPreviewRequestSchema.parse({ agent, ...(model === undefined ? {} : { model }) });
    const answer = await this.client.call('POST /v1/ferrets/:ferretId/conversion-preview', {
      params: { ferretId: id },
      body,
    });
    return ConversionPreviewSchema.parse(answer);
  }
}
