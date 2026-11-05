import { type VoiceEngineView, VoiceEngineViewSchema, type VoiceModelRequest } from '@ferretry/protocol';
import type { IVoiceGateway, VoiceApiClient } from './ports.ts';

/** The speech-engine routes. */
export const VOICE_ENGINE_PATH = '/v1/voice/engine';

/** Speaks the speech-engine routes through the protocol client, parsing every response. */
export class ProtocolVoiceGateway implements IVoiceGateway {
  constructor(private readonly client: VoiceApiClient) {}

  async status(): Promise<VoiceEngineView> {
    return await this.client.request(VOICE_ENGINE_PATH, VoiceEngineViewSchema, { method: 'GET' });
  }

  async install(id: string): Promise<VoiceEngineView> {
    return await this.#act('install', { id });
  }

  async cancel(): Promise<VoiceEngineView> {
    return await this.client.request(`${VOICE_ENGINE_PATH}/cancel`, VoiceEngineViewSchema, { method: 'POST' });
  }

  async remove(id: string): Promise<VoiceEngineView> {
    return await this.#act('remove', { id });
  }

  async use(id: string): Promise<VoiceEngineView> {
    return await this.#act('use', { id });
  }

  async #act(act: 'install' | 'remove' | 'use', body: VoiceModelRequest): Promise<VoiceEngineView> {
    return await this.client.request(`${VOICE_ENGINE_PATH}/${act}`, VoiceEngineViewSchema, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}
