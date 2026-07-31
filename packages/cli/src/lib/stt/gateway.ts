import {
  type SttEnhancementRequest,
  SttEnhancementRequestSchema,
  type SttEnhancementResult,
  SttEnhancementResultSchema,
  type SttModelListResponse,
  SttModelListResponseSchema,
  type SttModelStatus,
  SttModelStatusSchema,
  type SttStatus,
  SttStatusSchema,
  type SttTranscript,
  SttTranscriptSchema,
} from '@ferretry/protocol';
import type { ISttGateway, SttApiClient } from './ports.ts';

/** The dictation routes. */
export const STT_STATUS_PATH = '/v1/stt/status';
export const STT_MODELS_PATH = '/v1/stt/models';
export const STT_TRANSCRIBE_PATH = '/v1/stt/transcribe';
export const STT_ENHANCE_PATH = '/v1/stt/enhance';

/** One model's install route — a GET reads its progress, a POST starts it. */
export function sttInstallPath(modelId: string): string {
  return `${STT_MODELS_PATH}/${encodeURIComponent(modelId)}/install`;
}

/**
 * How long a transcription may take.
 *
 * A cold worker loads the model before it decodes anything, so the default request timeout — sized
 * for a JSON round trip — cancels a first transcription that was about to succeed.
 */
export const STT_TRANSCRIBE_TIMEOUT_MS = 180_000;

/** Speaks the dictation routes through the protocol client, parsing every response. */
export class ProtocolSttGateway implements ISttGateway {
  constructor(private readonly client: SttApiClient) {}

  async status(): Promise<SttStatus> {
    return await this.client.request(STT_STATUS_PATH, SttStatusSchema);
  }

  async models(): Promise<SttModelListResponse> {
    return await this.client.request(STT_MODELS_PATH, SttModelListResponseSchema);
  }

  async modelStatus(modelId: string): Promise<SttModelStatus> {
    return await this.client.request(sttInstallPath(modelId), SttModelStatusSchema);
  }

  async install(modelId: string): Promise<SttModelStatus> {
    return await this.client.request(sttInstallPath(modelId), SttModelStatusSchema, { method: 'POST' });
  }

  async transcribe(audio: Uint8Array, contentType: string): Promise<SttTranscript> {
    return await this.client.request(
      STT_TRANSCRIBE_PATH,
      SttTranscriptSchema,
      {
        method: 'POST',
        headers: { 'content-type': contentType, 'content-length': String(audio.byteLength) },
        body: audio,
      },
      STT_TRANSCRIBE_TIMEOUT_MS,
    );
  }

  async enhance(request: SttEnhancementRequest): Promise<SttEnhancementResult> {
    const body = SttEnhancementRequestSchema.parse(request);
    return await this.client.request(STT_ENHANCE_PATH, SttEnhancementResultSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
