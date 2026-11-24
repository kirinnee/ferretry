/**
 * What an image costs, per model, with the page each price was read from (checked 2026-11-24). A table is the FLOOR
 * of what Create knows: for a fal model it asks fal's own price endpoint first (`GET api.fal.ai/v1/models/pricing`,
 * https://fal.ai/docs/platform-apis/v1/models/pricing) and uses that answer when it names a unit this file can
 * price. The table prices a call when that answer cannot be had, and it is the allow-list: a model that is not
 * here is never called, so there is no call whose price is a guess.
 *
 * Pure: numbers in, numbers out. Money is whole MICRO-DOLLARS (1 USD = 1 000 000), so nothing adds up in floats.
 */
import { z } from 'zod';

export type MicroUsd = number;

/** `$0.03`, or `$0.003` under a cent: rounded UP, so it never shows less than it costs. */
export function usdWords(micro: MicroUsd): string {
  if (micro >= 10_000) return `$${(Math.ceil(micro / 10_000) / 100).toFixed(2)}`;
  return `$${(Math.ceil(micro / 100) / 10_000).toFixed(4).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

/** What fal bills an image model by. */
export type FalUnit = 'megapixel' | 'image' | 'second' | 'minute';

export const IMAGE_MODEL_IDS = ['flux-schnell', 'flux-dev', 'flux-pro'] as const;
export const ImageModelIdSchema = z.enum(IMAGE_MODEL_IDS);
export type ImageModelId = z.infer<typeof ImageModelIdSchema>;

export interface ImageModel {
  /** The name a ferret passes: short, stable, and not fal's path. */
  readonly id: ImageModelId;
  /** fal's endpoint id, used for the call and for the live price. */
  readonly endpoint: string;
  readonly summary: string;
  readonly unit: FalUnit;
  /** The listed price per `unit`, in micro-dollars. */
  readonly tableMicroUsd: MicroUsd;
  /** The page the table price was read from, shown beside the price wherever it is shown. */
  readonly source: string;
}

export const DEFAULT_IMAGE_MODEL: ImageModelId = 'flux-schnell';

export const IMAGE_MODELS: Readonly<Record<ImageModelId, ImageModel>> = Object.freeze({
  'flux-schnell': {
    id: 'flux-schnell',
    endpoint: 'fal-ai/flux/schnell',
    summary: 'fast and cheap, four steps; good for drafts',
    unit: 'megapixel',
    tableMicroUsd: 3_000,
    source: 'https://fal.ai/models/fal-ai/flux/schnell/llms.txt ($0.003 per megapixel)',
  },
  'flux-dev': {
    id: 'flux-dev',
    endpoint: 'fal-ai/flux/dev',
    summary: 'better detail and prompt-following than schnell',
    unit: 'megapixel',
    tableMicroUsd: 25_000,
    source: 'https://fal.ai/models/fal-ai/flux/dev/llms.txt ($0.025 per megapixel)',
  },
  'flux-pro': {
    id: 'flux-pro',
    endpoint: 'fal-ai/flux-pro/v1.1',
    summary: 'the best of the three; for a picture that has to look right',
    unit: 'megapixel',
    tableMicroUsd: 40_000,
    source: 'https://fal.ai/models/fal-ai/flux-pro/v1.1/llms.txt ($0.04 per megapixel)',
  },
});

/** The sizes a ferret may ask for: fal's own named sizes, each a fixed width and height at or just over one megapixel. */
export const IMAGE_SIZES = Object.freeze({
  square_hd: { width: 1024, height: 1024 },
  square: { width: 512, height: 512 },
  portrait_4_3: { width: 768, height: 1024 },
  portrait_16_9: { width: 576, height: 1024 },
  landscape_4_3: { width: 1024, height: 768 },
  landscape_16_9: { width: 1024, height: 576 },
} as const);
export type ImageSizeId = keyof typeof IMAGE_SIZES;
export const IMAGE_SIZE_IDS = Object.keys(IMAGE_SIZES) as [ImageSizeId, ...ImageSizeId[]];
export const ImageSizeIdSchema = z.enum(IMAGE_SIZE_IDS);
export const DEFAULT_IMAGE_SIZE: ImageSizeId = 'landscape_4_3';

/** What fal's price endpoint answered for one endpoint: a rate and the unit it is per. */
export interface LiveRate {
  readonly unitPrice: number;
  readonly unit: string;
}

/** Where a price came from, said beside it: `fal` (its own price endpoint, asked just now) or `table` (this file). */
export type PriceSource = 'fal' | 'table';

export type Priced =
  | { readonly ok: true; readonly microUsd: MicroUsd; readonly from: PriceSource }
  | { readonly ok: false; readonly why: string };

const unitOf = (text: string): FalUnit | undefined => {
  const lower = text.toLowerCase().trim();
  if (lower.includes('megapixel')) return 'megapixel';
  if (lower === 'image' || lower === 'images') return 'image';
  if (lower === 'second' || lower === 'seconds') return 'second';
  if (lower === 'minute' || lower === 'minutes' || lower === 'audio minute' || lower === 'audio minutes')
    return 'minute';
  return undefined;
};

/** A rate read as micro-dollars per unit, from the table or from fal, or `undefined` when it cannot be priced. */
const rateOf = (
  table: { readonly unit: FalUnit; readonly tableMicroUsd: MicroUsd },
  live: LiveRate | undefined,
  allowed: readonly FalUnit[],
): { readonly unit: FalUnit; readonly microUsd: number; readonly from: PriceSource } | undefined => {
  const unit = live === undefined ? table.unit : unitOf(live.unit);
  const microUsd = live === undefined ? table.tableMicroUsd : live.unitPrice * 1_000_000;
  if (unit === undefined || !allowed.includes(unit) || !Number.isFinite(microUsd) || microUsd < 0) return undefined;
  return { unit, microUsd, from: live === undefined ? 'table' : 'fal' };
};

const cannotPrice = (endpoint: string, who: string): Priced => ({
  ok: false,
  why: `${who} prices ${endpoint} in a unit Create cannot price, so nothing was sent`,
});

/**
 * The cost of ONE image of this size on this model, rounded UP to a micro-dollar. A megapixel rate is proportional
 * to the output's area; a per-image rate is flat, but a picture over one megapixel is priced as that many, so the
 * estimate is never below what a per-megapixel bill would be. A live rate in a unit this file cannot price is
 * REFUSED, never guessed: a price the owner was not shown is not spent.
 */
export function priceImage(model: ImageModel, size: ImageSizeId, live?: LiveRate): Priced {
  const { width, height } = IMAGE_SIZES[size];
  const megapixels = (width * height) / 1_000_000;
  const rate = rateOf(model, live, ['megapixel', 'image']);
  if (rate === undefined) return cannotPrice(model.endpoint, 'fal');
  const area = rate.unit === 'megapixel' ? megapixels : Math.max(1, megapixels);
  return { ok: true, microUsd: Math.ceil(rate.microUsd * area), from: rate.from };
}

// ─── sound: speech, effects, music ───────────────────────────────────────────────────────────────────────────────

/** Speech is cut off here so an answer is about 100 s of audio, which fits the chat's 1 MiB at 64 kbit/s. */
export const MAX_SPEECH_CHARS = 1_500;
/** The voice a ferret gets when it names none: ElevenLabs' premade "Rachel" (a public, stable id). */
export const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM';
/** The audio format every sound is asked for: MP3 at 64 kbit/s, 8 000 bytes a second, so a minute is under 0.5 MiB. */
export const AUDIO_FORMAT = 'mp3_44100_64';

export const SPEECH_MODEL_IDS = ['flash', 'multilingual'] as const;
export const SpeechModelIdSchema = z.enum(SPEECH_MODEL_IDS);
export type SpeechModelId = z.infer<typeof SpeechModelIdSchema>;
export const DEFAULT_SPEECH_MODEL: SpeechModelId = 'flash';

export interface SpeechModel {
  readonly id: SpeechModelId;
  /** ElevenLabs' own `model_id`. */
  readonly modelId: string;
  readonly summary: string;
  /** The listed price per 1 000 characters of TEXT, in micro-dollars. ElevenLabs has no price endpoint: this is the price. */
  readonly tableMicroUsdPer1kChars: MicroUsd;
  readonly source: string;
}

export const SPEECH_MODELS: Readonly<Record<SpeechModelId, SpeechModel>> = Object.freeze({
  flash: {
    id: 'flash',
    modelId: 'eleven_flash_v2_5',
    summary: 'fast and cheap; good for a voiceover or a reply read aloud',
    tableMicroUsdPer1kChars: 50_000,
    source: 'https://elevenlabs.io/pricing/api (Flash / Turbo, $0.05 per 1 000 characters)',
  },
  multilingual: {
    id: 'multilingual',
    modelId: 'eleven_multilingual_v2',
    summary: 'richer voice, many languages; twice the price of flash',
    // The pages differ ($0.08 on one, $0.10 on others): the table keeps the higher, so a price is never under.
    tableMicroUsdPer1kChars: 100_000,
    source: 'https://elevenlabs.io/pricing/api (Multilingual v2, $0.10 per 1 000 characters; one page says $0.08)',
  },
});

/** What reading `characters` characters costs: rounded UP, never below the listed price. */
export function priceSpeech(model: SpeechModel, characters: number): Priced {
  return { ok: true, microUsd: Math.ceil((model.tableMicroUsdPer1kChars * characters) / 1_000), from: 'table' };
}

export const SFX_ENDPOINT = 'fal-ai/elevenlabs/sound-effects/v2';
export const SFX_TABLE = {
  unit: 'second',
  tableMicroUsd: 2_000,
  source: 'https://fal.ai/models/fal-ai/elevenlabs/sound-effects/v2/llms.txt ($0.002 per second)',
} as const;
export const MIN_SFX_SECONDS = 0.5;
export const MAX_SFX_SECONDS = 22;
export const DEFAULT_SFX_SECONDS = 5;

/** A sound effect of `seconds` seconds. A per-second rate is billed by the whole second, a per-minute one by the whole minute: never under. */
export function priceSfx(seconds: number, live?: LiveRate): Priced {
  const rate = rateOf(SFX_TABLE, live, ['second', 'minute']);
  if (rate === undefined) return cannotPrice(SFX_ENDPOINT, 'fal');
  const units = Math.ceil(rate.unit === 'second' ? seconds : seconds / 60);
  return { ok: true, microUsd: Math.ceil(rate.microUsd * units), from: rate.from };
}

export const MUSIC_ENDPOINT = 'fal-ai/elevenlabs/music';
export const MUSIC_TABLE = {
  unit: 'minute',
  tableMicroUsd: 600_000,
  source: 'https://fal.ai/models/fal-ai/elevenlabs/music/llms.txt ($0.60 per output audio minute, rounded up)',
} as const;
export const MIN_MUSIC_SECONDS = 3;
export const MAX_MUSIC_SECONDS = 60;
export const DEFAULT_MUSIC_SECONDS = 30;

/**
 * A short piece of music. fal bills it by the audio minute, ROUNDED UP to the whole minute (30 s is billed as 60 s), so
 * a per-second live rate is also priced from the whole minute: the estimate is never under what fal bills.
 */
export function priceMusic(seconds: number, live?: LiveRate): Priced {
  const rate = rateOf(MUSIC_TABLE, live, ['second', 'minute']);
  if (rate === undefined) return cannotPrice(MUSIC_ENDPOINT, 'fal');
  const minutes = Math.ceil(seconds / 60);
  return {
    ok: true,
    microUsd: Math.ceil(rate.microUsd * (rate.unit === 'minute' ? minutes : minutes * 60)),
    from: rate.from,
  };
}

// ─── video: Kling 2.6 Pro and Veo 3.1 Fast through fal's queue ───────────────────────────────────────────────────

export const VIDEO_MODEL_IDS = ['kling', 'veo-fast'] as const;
export const VideoModelIdSchema = z.enum(VIDEO_MODEL_IDS);
export type VideoModelId = z.infer<typeof VideoModelIdSchema>;
export const DEFAULT_VIDEO_MODEL: VideoModelId = 'kling';

export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'] as const;
export const VideoAspectSchema = z.enum(VIDEO_ASPECTS);
export type VideoAspect = z.infer<typeof VideoAspectSchema>;

export const VIDEO_RESOLUTIONS = ['720p', '1080p'] as const;
export const VideoResolutionSchema = z.enum(VIDEO_RESOLUTIONS);
export type VideoResolution = z.infer<typeof VideoResolutionSchema>;

export interface VideoModel {
  readonly id: VideoModelId;
  /** fal's endpoint id: what a request is sent to and what the live price is asked for. */
  readonly endpoint: string;
  readonly summary: string;
  /** The clip lengths fal takes, in seconds: a length not here is refused before anything is sent. */
  readonly seconds: readonly number[];
  readonly defaultSeconds: number;
  readonly aspects: readonly VideoAspect[];
  /** Whether the model has a choice of resolution (Kling's is fixed). */
  readonly resolutions: readonly VideoResolution[];
  /** The listed price per second of video, in micro-dollars, with the sound off and on (720p and 1080p price alike). */
  readonly tableMicroUsdPerSecond: { readonly silent: MicroUsd; readonly sound: MicroUsd };
  readonly source: string;
}

export const VIDEO_MODELS: Readonly<Record<VideoModelId, VideoModel>> = Object.freeze({
  kling: {
    id: 'kling',
    endpoint: 'fal-ai/kling-video/v2.6/pro/text-to-video',
    summary: 'Kling 2.6 Pro: cinematic motion, a 5 s or 10 s clip',
    seconds: [5, 10],
    defaultSeconds: 5,
    aspects: ['16:9', '9:16', '1:1'],
    resolutions: [],
    tableMicroUsdPerSecond: { silent: 70_000, sound: 140_000 },
    source:
      'https://fal.ai/models/fal-ai/kling-video/v2.6/pro/text-to-video/llms.txt ($0.07 per second, $0.14 with audio)',
  },
  'veo-fast': {
    id: 'veo-fast',
    endpoint: 'fal-ai/veo3.1/fast',
    summary: 'Veo 3.1 Fast: a 4, 6 or 8 s clip at 720p or 1080p',
    seconds: [4, 6, 8],
    defaultSeconds: 8,
    aspects: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    tableMicroUsdPerSecond: { silent: 100_000, sound: 150_000 },
    source: 'https://fal.ai/models/fal-ai/veo3.1/fast/llms.txt ($0.10 per second, $0.15 with audio, 720p and 1080p)',
  },
});

export const DEFAULT_VIDEO_ASPECT: VideoAspect = '16:9';
export const DEFAULT_VIDEO_RESOLUTION: VideoResolution = '720p';

/**
 * A clip of `seconds` seconds. fal's own rate (asked just now) is ONE number per endpoint, but the table has a price
 * for sound off and on; fal's rate is not known to be for the choice made, so the clip is priced at the HIGHER of the
 * two. A price that fell at fal is therefore not seen, and one that rose is: the estimate is never under the bill.
 * A live rate in a unit other than the second is refused.
 */
export function priceVideo(model: VideoModel, seconds: number, sound: boolean, live?: LiveRate): Priced {
  const table = sound ? model.tableMicroUsdPerSecond.sound : model.tableMicroUsdPerSecond.silent;
  if (live === undefined) return { ok: true, microUsd: Math.ceil(table * seconds), from: 'table' };
  if (unitOf(live.unit) !== 'second' || !Number.isFinite(live.unitPrice) || live.unitPrice < 0)
    return cannotPrice(model.endpoint, 'fal');
  const liveMicro = live.unitPrice * 1_000_000;
  return liveMicro > table
    ? { ok: true, microUsd: Math.ceil(liveMicro * seconds), from: 'fal' }
    : { ok: true, microUsd: Math.ceil(table * seconds), from: 'table' };
}
