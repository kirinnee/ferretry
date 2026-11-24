/**
 * The browser's half of Voice mode's machine engine: three calls, no audio and no secret. The machine downloads the
 * speech files itself (Install answers at once; the panel reads the state again until it is no longer installing).
 */
import { type VoiceEngineView, VoiceEngineViewSchema } from '../../../contract/index.ts';
import type { IFyApiClient } from '../../shell-voice.ts';

export type VoiceEngineClient = Pick<IFyApiClient, 'request'>;

const ENGINE_PATH = '/v1/voice/engine';

export const readVoiceEngine = async (client: VoiceEngineClient): Promise<VoiceEngineView> =>
  await client.request(ENGINE_PATH, VoiceEngineViewSchema, { quiet: true });

export const installVoiceEngine = async (client: VoiceEngineClient): Promise<VoiceEngineView> =>
  await client.request(`${ENGINE_PATH}/install`, VoiceEngineViewSchema, { method: 'POST' });

export const removeVoiceEngine = async (client: VoiceEngineClient): Promise<VoiceEngineView> =>
  await client.request(ENGINE_PATH, VoiceEngineViewSchema, { method: 'DELETE' });
