/**
 * ElevenLabs over `kernel.secrets.send`, the same way fal is: the KERNEL places `ELEVENLABS_API_KEY` (as `xi-api-key`),
 * so this file never holds it. The Vault's outbound holder returns ONLY parsed JSON (docs/secrets.md), so raw audio is
 * not on offer (owner decision O4, 2026-11-24): speech comes from the `with-timestamps` endpoint, which answers JSON
 * with the audio as base64, and the bytes are decoded here. ElevenLabs music is NOT called here: it goes through fal.
 *
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 */
import type { CredentialPlacement, SecretsPort } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { AUDIO_FORMAT } from '../../contract/index.ts';
import { answerOf, type FalFailure, type Provider } from './fal.ts';

const KEY_NAME = 'ELEVENLABS_API_KEY';
const HOST = 'api.elevenlabs.io';
const PLACEMENT: CredentialPlacement = { header: 'xi-api-key' };

/** ≤ 4 MiB of JSON: the audio as base64 plus a timing for every letter. 1 500 characters is about 1.4 MB of it. */
const RUN_BYTES = 4 * 1024 * 1024;
const RUN_TIMEOUT_MS = 90_000;
/** The longest audio Create will keep from one call, decoded: the same ceiling the JSON above allows. */
const MAX_SPEECH_BYTES = 3 * 1024 * 1024;

export const ELEVENLABS: Provider = {
  name: 'ElevenLabs',
  noKey:
    'speech is off: no ElevenLabs key. The owner adds one with `fy secret set ELEVENLABS_API_KEY`, then names it in create.yaml as `elevenlabs: { key: ${secret:ELEVENLABS_API_KEY} }`',
};

/** Only the audio is read from the answer: its timing arrays are large and Create does not use them. */
const SpeechReplySchema = z.object({ audio_base64: z.string().min(1) });

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

/** The bytes of one voiceover as MP3, or why there are none. */
export async function runSpeech(
  secrets: SecretsPort,
  voice: string,
  modelId: string,
  text: string,
): Promise<{ readonly bytes: Uint8Array } | FalFailure> {
  const outcome = await secrets.send(
    KEY_NAME,
    {
      method: 'POST',
      url: `https://${HOST}/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=${AUDIO_FORMAT}`,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ text, model_id: modelId }),
      timeoutMs: RUN_TIMEOUT_MS,
      maxResponseBytes: RUN_BYTES,
    },
    PLACEMENT,
  );
  const answer = answerOf(outcome, ELEVENLABS);
  if ('code' in answer) return answer;
  const parsed = SpeechReplySchema.safeParse(answer.payload);
  if (!parsed.success || !BASE64.test(parsed.data.audio_base64))
    return { code: 'unavailable', sentence: 'ElevenLabs made no speech (its answer held no audio)' };
  const bytes = new Uint8Array(Buffer.from(parsed.data.audio_base64, 'base64'));
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SPEECH_BYTES)
    return { code: 'unavailable', sentence: 'ElevenLabs made speech Create could not keep' };
  return { bytes };
}
