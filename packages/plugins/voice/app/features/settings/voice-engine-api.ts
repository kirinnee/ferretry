/**
 * The browser's half of Voice mode's machine engine: three calls, no audio and no secret. The machine downloads the
 * speech files itself (Install answers at once; the panel reads the state again until it is no longer installing).
 */
import {
  type ReplyVoiceView,
  ReplyVoiceViewSchema,
  type VoiceEngineView,
  VoiceEngineViewSchema,
} from '../../../contract/index.ts';
import type { IFyApiClient } from '../../shell-voice.ts';

export type VoiceEngineClient = Pick<IFyApiClient, 'request'>;

const ENGINE_PATH = '/v1/voice/engine';

export const readVoiceEngine = async (client: VoiceEngineClient): Promise<VoiceEngineView> =>
  await client.request(ENGINE_PATH, VoiceEngineViewSchema, { quiet: true });

export const installVoiceEngine = async (client: VoiceEngineClient): Promise<VoiceEngineView> =>
  await client.request(`${ENGINE_PATH}/install`, VoiceEngineViewSchema, { method: 'POST' });

export const removeVoiceEngine = async (client: VoiceEngineClient): Promise<VoiceEngineView> =>
  await client.request(ENGINE_PATH, VoiceEngineViewSchema, { method: 'DELETE' });

const REPLY_PATH = '/v1/voice/reply-voice';

/** The reply voice (Kokoro) on the machine: the same three calls as the engine, on its own route. */
export const readReplyVoice = async (client: VoiceEngineClient): Promise<ReplyVoiceView> =>
  await client.request(REPLY_PATH, ReplyVoiceViewSchema, { quiet: true });

export const installReplyVoice = async (client: VoiceEngineClient): Promise<ReplyVoiceView> =>
  await client.request(`${REPLY_PATH}/install`, ReplyVoiceViewSchema, { method: 'POST' });

export const removeReplyVoice = async (client: VoiceEngineClient): Promise<ReplyVoiceView> =>
  await client.request(REPLY_PATH, ReplyVoiceViewSchema, { method: 'DELETE' });
