import type { PluginClient } from '@ferretry/kernel/manifest';
import { type FerretSummary, FerretSummarySchema } from '../../../contract/ids.ts';
import {
  type ConversionPreview,
  ConversionPreviewRequestSchema,
  ConversionPreviewSchema,
  type MoveConversation,
  MoveSessionRequestSchema,
} from '../../../contract/move.ts';
import type { IMoveGateway } from './ports.ts';

/**
 * Today's `FyApiClient.move` / `conversionPreview`, over the plugin client and the move routes. The move carries its
 * logical request id as `x-fy-request-id`, the one header the plugin client lets a half set: the route refuses a body
 * without it (`missing_request_id`), because a retried POST without it would kill and relaunch the pane a second time.
 */
export class ClientMoveGateway implements IMoveGateway {
  constructor(
    private readonly client: PluginClient,
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
  ): Promise<FerretSummary> {
    const body = MoveSessionRequestSchema.parse({
      agent,
      model,
      allowContextDowngrade,
      forceInflight,
      ...(conversation === undefined ? {} : { conversation }),
    });
    const answer = await this.client.call<unknown>('POST /v1/ferrets/:ferretId/move', {
      params: { ferretId: id },
      body,
      headers: { 'x-fy-request-id': requestId ?? this.mintRequestId() },
    });
    return FerretSummarySchema.parse(answer);
  }

  async conversionPreview(id: string, agent: string, model?: string): Promise<ConversionPreview> {
    const body = ConversionPreviewRequestSchema.parse({ agent, ...(model === undefined ? {} : { model }) });
    const answer = await this.client.call<unknown>('POST /v1/ferrets/:ferretId/conversion-preview', {
      params: { ferretId: id },
      body,
    });
    return ConversionPreviewSchema.parse(answer);
  }
}
