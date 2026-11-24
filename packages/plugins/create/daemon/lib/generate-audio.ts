/**
 * `generate_speech`, `generate_sfx` and `generate_music`: the sound tools. Each is `generate_image`'s order with a
 * different provider (docs/create.md): key → price BEFORE sending → the shared money steps (`paid-call.ts`) → fetch or
 * decode the file → hand it to the ferret's media folder → one piece to paste, cost line first.
 *
 *   - speech: ElevenLabs' JSON `with-timestamps` endpoint through the Vault, base64 decoded here. Priced from a table
 *     (ElevenLabs has no price endpoint), by the characters of text.
 *   - sound effects and music: fal (`fal-ai/elevenlabs/…`; ElevenLabs music goes through fal, owner decision O4). Priced
 *     by fal's own price endpoint when it answers in seconds or minutes, else the table.
 */
import { createHash } from 'node:crypto';
import type { FetchPort, SecretsPort } from '@ferretry/kernel/contract';
import {
  GenerateMusicInputSchema,
  GenerateSfxInputSchema,
  GenerateSpeechInputSchema,
  MAX_CHAT_MEDIA_BYTES,
  MUSIC_ENDPOINT,
  priceMusic,
  priceSfx,
  priceSpeech,
  SFX_ENDPOINT,
  SPEECH_MODELS,
} from '../../contract/index.ts';
import { ELEVENLABS, runSpeech } from './elevenlabs.ts';
import { FAL, runMusic, runSfx } from './fal.ts';
import {
  altOf,
  type DeliverMedia,
  download,
  failed,
  falRate,
  kib,
  type Paid,
  paidCall,
  type PaidDeps,
  refusal,
  requestDigest,
  type Serial,
  type ToolAnswer,
  unfetched,
} from './paid-call.ts';

export interface GenerateAudioDeps extends PaidDeps {
  readonly secrets: SecretsPort;
  readonly fetch: FetchPort;
  readonly deliver: DeliverMedia;
  readonly serial: Serial;
}

const SOUND_TYPES = ['audio/mpeg', 'audio/mp3'];

/** The file is made and paid for: save it, then answer with the one piece to paste. */
async function present(
  deps: GenerateAudioDeps,
  ferret: string,
  made: { readonly noun: string; readonly name: string; readonly alt: string; readonly summary: string },
  bytes: Uint8Array,
  paid: Extract<Paid<object>, { ok: true }>,
): Promise<ToolAnswer> {
  const where = await deps.deliver(ferret, made.name, bytes);
  if (where === undefined)
    return refusal(
      `The ${made.noun} was made and paid for (${paid.paid}), but it could not be saved for you. It was not kept.`,
    );
  const shown =
    bytes.byteLength <= MAX_CHAT_MEDIA_BYTES
      ? [
          'Put these lines in your reply:',
          paid.costLine,
          '```fy-render',
          'type: audio',
          `alt: ${made.alt}`,
          `src: media:${where}`,
          '---',
          '```',
        ]
      : [
          `It is ${kib(bytes.byteLength)}, over the 1 MB the chat plays, so there is no player block. Put this line in your reply:`,
          paid.costLine,
          `The file is in your media folder as ${where}.`,
        ];
  return { text: [`Made ${made.summary} for ${paid.paid}.`, ...shown].join('\n') };
}

const hashed = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 8);

function generateSpeechTool(deps: GenerateAudioDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(async () => {
      const parsed = GenerateSpeechInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The speech request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const input = parsed.data;
      if (deps.config().elevenlabs.key === undefined) return failed({ code: 'no_key', sentence: ELEVENLABS.noKey });
      const model = SPEECH_MODELS[input.model];
      const priced = priceSpeech(model, input.text.length);
      if (!priced.ok) return refusal(`${priced.why}.`);

      const paid = await paidCall(deps, {
        tool: 'generate_speech',
        model: model.id,
        label: `${model.id} voice, ${input.text.length} characters`,
        ferret,
        request: requestDigest('generate_speech', { text: input.text, voice: input.voice, model: input.model }),
        cost: priced.microUsd,
        priced: priced.from,
        provider: 'ElevenLabs',
        what: 'a voiceover',
        promptLabel: 'Text',
        prompt: input.text,
        cheaper: 'Ask for a shorter text or the flash model',
        run: () => runSpeech(deps.secrets, input.voice, model.modelId, input.text),
      });
      if (!paid.ok) return paid.answer;
      const { bytes } = paid.value;
      return await present(
        deps,
        ferret,
        {
          noun: 'speech',
          name: `create-speech-${model.id}-${hashed(bytes)}.mp3`,
          alt: altOf(input.text),
          summary: `one voiceover with ${model.id}`,
        },
        bytes,
        paid,
      );
    });
}

function generateSfxTool(deps: GenerateAudioDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(async () => {
      const parsed = GenerateSfxInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The sound effect request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const input = parsed.data;
      if (deps.config().fal.key === undefined) return failed({ code: 'no_key', sentence: FAL.noKey });
      const rate = await falRate(deps.secrets, SFX_ENDPOINT);
      if (rate.kind === 'end') return rate.answer;
      const priced = priceSfx(input.seconds, rate.live);
      if (!priced.ok) return refusal(`${priced.why}.`);

      const paid = await paidCall(deps, {
        tool: 'generate_sfx',
        model: 'sound-effects',
        label: `sound effect, ${input.seconds} s`,
        ferret,
        request: requestDigest('generate_sfx', { prompt: input.prompt, seconds: input.seconds }),
        cost: priced.microUsd,
        priced: priced.from,
        provider: 'fal',
        what: 'one sound effect',
        promptLabel: 'Prompt',
        prompt: input.prompt,
        cheaper: 'Ask for a shorter one',
        run: () => runSfx(deps.secrets, input.prompt, input.seconds),
      });
      if (!paid.ok) return paid.answer;
      return await finish(deps, ferret, paid, input.prompt, 'sound effect', `a ${input.seconds} s sound effect`, 'sfx');
    });
}

function generateMusicTool(deps: GenerateAudioDeps) {
  return (ferret: string, rawInput: unknown): Promise<ToolAnswer> =>
    deps.serial(async () => {
      const parsed = GenerateMusicInputSchema.safeParse(rawInput);
      if (!parsed.success)
        return refusal(`The music request is not valid: ${parsed.error.issues[0]?.message ?? 'bad input'}.`);
      const input = parsed.data;
      if (deps.config().fal.key === undefined) return failed({ code: 'no_key', sentence: FAL.noKey });
      const rate = await falRate(deps.secrets, MUSIC_ENDPOINT);
      if (rate.kind === 'end') return rate.answer;
      const priced = priceMusic(input.seconds, rate.live);
      if (!priced.ok) return refusal(`${priced.why}.`);

      const paid = await paidCall(deps, {
        tool: 'generate_music',
        model: 'music',
        label: `music, ${input.seconds} s`,
        ferret,
        request: requestDigest('generate_music', {
          prompt: input.prompt,
          seconds: input.seconds,
          instrumental: input.instrumental,
        }),
        cost: priced.microUsd,
        priced: priced.from,
        provider: 'fal',
        what: 'a short piece of music',
        promptLabel: 'Prompt',
        prompt: input.prompt,
        // fal bills music by the whole minute, so a shorter piece is not cheaper: only a plainer ask can be.
        cheaper: 'Ask for a sound effect or speech',
        run: () => runMusic(deps.secrets, input.prompt, input.seconds, input.instrumental),
      });
      if (!paid.ok) return paid.answer;
      return await finish(deps, ferret, paid, input.prompt, 'music', `${input.seconds} s of music`, 'music');
    });
}

/** The file fal made is on its storage: fetch it (no key), then hand it over. */
async function finish(
  deps: GenerateAudioDeps,
  ferret: string,
  paid: Extract<Paid<{ readonly url: string }>, { ok: true }>,
  prompt: string,
  noun: string,
  summary: string,
  prefix: string,
): Promise<ToolAnswer> {
  const got = await download(deps.fetch, paid.value.url, SOUND_TYPES, 'sound');
  if ('why' in got) return unfetched(noun, paid.paid, got);
  return await present(
    deps,
    ferret,
    { noun, name: `create-${prefix}-${hashed(got.bytes)}.mp3`, alt: altOf(prompt), summary },
    got.bytes,
    paid,
  );
}

/** The three sound tools, each a ferret's call: the daemon names them. */
export function generateAudioTools(deps: GenerateAudioDeps) {
  return {
    generate_speech: generateSpeechTool(deps),
    generate_sfx: generateSfxTool(deps),
    generate_music: generateMusicTool(deps),
  };
}
