/**
 * The reply voice as `voice.yaml` holds it (`replyVoice`): Kokoro on the machine, or ElevenLabs and which of its voices.
 *
 * The file is read and edited as TEXT (the owner's comments and key order survive; only the keys that change are rewritten),
 * exactly as the dictation clean-up settings are (`lib/stt/voice-cleanup.ts`). Nothing here can hold a key: the file names
 * a provider and a voice, and the key is a Vault secret by name.
 */

import { editConfigText, readConfigText } from '@ferretry/std/yaml';
import { type ReplyProvider, VoiceConfigSchema } from '../../contract/index.ts';

const VOICE_SCHEMA_MODELINE = '# yaml-language-server: $schema=.schema/voice.json';

export interface ReplyVoiceChoice {
  readonly provider: ReplyProvider;
  readonly voiceId: string | undefined;
  readonly voiceName: string | undefined;
  readonly dailyChars: number;
}

export const DEFAULT_REPLY_VOICE_CHOICE: ReplyVoiceChoice = Object.freeze({
  provider: 'kokoro',
  voiceId: undefined,
  voiceName: undefined,
  dailyChars: 20_000,
});

/** A change to ask for: the source, and/or the ElevenLabs voice (its id and the name the picker showed). */
export interface ReplyVoicePatch {
  readonly provider?: ReplyProvider;
  readonly voice?: { readonly id: string; readonly name: string };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parsed = (text: string): { readonly raw: Record<string, unknown>; readonly choice: ReplyVoiceChoice } | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const checked = VoiceConfigSchema.safeParse(read.read.value);
  if (!checked.success) return null;
  const { provider, elevenlabs } = checked.data.replyVoice;
  return {
    raw: isRecord(read.read.value) ? read.read.value : {},
    choice: {
      provider,
      voiceId: elevenlabs.voiceId,
      voiceName: elevenlabs.voiceName,
      dailyChars: elevenlabs.dailyChars,
    },
  };
};

/** The reply voice `voice.yaml` names, or `null` when the file does not parse or check. */
export const readReplyVoice = (text: string): ReplyVoiceChoice | null => parsed(text)?.choice ?? null;

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** `voice.yaml` with the change made, or `null` when the file cannot be edited (it does not check). */
export const withReplyVoice = (text: string, patch: ReplyVoicePatch): string | null => {
  const before = parsed(text);
  if (before === null) return null;
  const { raw } = before;
  const rawReply = isRecord(raw.replyVoice) ? raw.replyVoice : {};
  const rawEleven = isRecord(rawReply.elevenlabs) ? rawReply.elevenlabs : {};
  let reply: Record<string, unknown> = { ...rawReply };
  let eleven: Record<string, unknown> = { ...rawEleven };

  // Kokoro is the default: choosing it deletes the key rather than writing the default.
  if (patch.provider !== undefined)
    reply = patch.provider === 'kokoro' ? withoutKey(reply, 'provider') : { ...reply, provider: patch.provider };
  if (patch.voice !== undefined)
    eleven = { ...eleven, voiceId: patch.voice.id, voiceName: patch.voice.name.trim().slice(0, 100) };
  reply = Object.keys(eleven).length === 0 ? withoutKey(reply, 'elevenlabs') : { ...reply, elevenlabs: eleven };

  const target = Object.keys(reply).length === 0 ? withoutKey(raw, 'replyVoice') : { ...raw, replyVoice: reply };
  const next = editConfigText(text, target, raw, VOICE_SCHEMA_MODELINE);
  return readReplyVoice(next) === null ? null : next;
};
