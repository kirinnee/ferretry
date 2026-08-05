import {
  type SttEnhancementRequest,
  SttEnhancementRequestSchema,
  type SttEnhancementResult,
  SttEnhancementResultSchema,
} from '@ferretry/protocol';
import type { ISttGateway, SttApiClient } from './ports.ts';

/** The dictation route. */
export const STT_ENHANCE_PATH = '/v1/stt/enhance';

/** Speaks the dictation route through the protocol client, parsing the response. */
export class ProtocolSttGateway implements ISttGateway {
  constructor(private readonly client: SttApiClient) {}

  async enhance(request: SttEnhancementRequest): Promise<SttEnhancementResult> {
    const body = SttEnhancementRequestSchema.parse(request);
    return await this.client.request(STT_ENHANCE_PATH, SttEnhancementResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
