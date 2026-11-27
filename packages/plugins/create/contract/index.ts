/**
 * `@ferretry/plugin-create/contract`: creative tools for agents that cannot make media themselves. This unit holds
 * the core every later tool stands on (pricing, the spend ledger, the daily cap, the ask over a limit) and the first
 * tool, `generate_image`. The wire contract is docs/create.md.
 */
import { audit } from '@ferretry/core-gate/contract';
import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import type { Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_ASPECT,
  DEFAULT_VIDEO_MODEL,
  DEFAULT_IMAGE_SIZE,
  DEFAULT_MUSIC_SECONDS,
  DEFAULT_SFX_SECONDS,
  DEFAULT_SPEECH_MODEL,
  DEFAULT_VOICE_ID,
  ImageModelIdSchema,
  ImageSizeIdSchema,
  MAX_MUSIC_SECONDS,
  MAX_SFX_SECONDS,
  MAX_SPEECH_CHARS,
  MIN_MUSIC_SECONDS,
  MIN_SFX_SECONDS,
  SpeechModelIdSchema,
  VideoAspectSchema,
  VideoModelIdSchema,
  VideoResolutionSchema,
} from './pricing.ts';
import { HEYGEN_KEY_REFERENCE } from './heygen.ts';

export * from './heygen.ts';
export * from './pricing.ts';

export const CREATE_WORDS: readonly Word[] = [
  { word: 'creative tool', means: 'an agent tool that makes an image, sound or video by calling a paid service' },
  {
    word: 'video job',
    means: 'a clip being made in fal’s queue: paid for when it is sent, and fetched later with generation_status',
  },
  { word: 'voiceover', means: 'speech read aloud from a ferret’s text by ElevenLabs, saved as one audio file' },
];

// ─── the key and the limits (config/create.yaml) ─────────────────────────────────────────────────────────────────

/** The ONE spelling `fal.key` takes: a reference to the secret the manifest declares, never a value. */
export const FAL_KEY_REFERENCE = '${secret:FAL_KEY}';

/** The ONE spelling `elevenlabs.key` takes: a reference to the secret the manifest declares, never a value. */
export const ELEVENLABS_KEY_REFERENCE = '${secret:ELEVENLABS_API_KEY}';

/** Owner decisions of 2026-11-23 (!A616): $5 a day in all, and a single call over $1 asks the owner first. */
export const DEFAULT_DAILY_USD = 5;
export const DEFAULT_ASK_ABOVE_USD = 1;

/** An IANA zone, so "a day" is the owner's day (docs/budgets.md): the same rule a login budget follows. */
const isTimeZone = (zone: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const UsdSchema = z.number().positive().max(1000);

export const CreateConfigSchema = z.strictObject({
  fal: z.strictObject({ key: z.literal(FAL_KEY_REFERENCE).optional() }).default({}),
  elevenlabs: z.strictObject({ key: z.literal(ELEVENLABS_KEY_REFERENCE).optional() }).default({}),
  heygen: z.strictObject({ key: z.literal(HEYGEN_KEY_REFERENCE).optional() }).default({}),
  limits: z
    .strictObject({
      dailyUsd: UsdSchema.default(DEFAULT_DAILY_USD),
      askAboveUsd: UsdSchema.default(DEFAULT_ASK_ABOVE_USD),
    })
    .default({ dailyUsd: DEFAULT_DAILY_USD, askAboveUsd: DEFAULT_ASK_ABOVE_USD }),
  timeZone: z
    .string()
    .refine(isTimeZone, { message: 'write "timeZone" as an IANA time zone, such as America/Los_Angeles or UTC' })
    .optional(),
});
export type CreateConfig = z.infer<typeof CreateConfigSchema>;
/** The config with the zone a day is counted in settled: the file's `timeZone`, else the host's own (as Usage's days are). */
export type ResolvedCreateConfig = CreateConfig & { readonly timeZone: string };

/** A higher limit, or another zone (which moves where a day ends), spends more than the owner agreed to: it is held. */
export function createLoosens(before: CreateConfig | undefined, after: CreateConfig): readonly string[] {
  const was = before ?? CreateConfigSchema.parse({});
  const held: string[] = [];
  if (after.limits.dailyUsd > was.limits.dailyUsd)
    held.push('a higher daily limit would let creative tools spend more');
  if (after.limits.askAboveUsd > was.limits.askAboveUsd)
    held.push('a higher ask threshold would let a dearer call go without asking');
  if (after.timeZone !== was.timeZone) held.push('another time zone moves where the spending day ends');
  return held;
}

export const CreateConfigFile = defineConfig({
  file: 'create.yaml',
  schema: CreateConfigSchema,
  axis: 'configure',
  loosens: createLoosens,
});
export const CreateConfigDef = CreateConfigFile as ConfigDef;

// ─── the ledger (state/create/ledger.jsonl) ──────────────────────────────────────────────────────────────────────

/** The tools that spend: one ledger and one daily cap hold them all. */
export const SPEND_TOOLS = [
  'generate_image',
  'generate_speech',
  'generate_sfx',
  'generate_music',
  'generate_video',
  'generate_avatar_video',
] as const;
export const SpendToolSchema = z.enum(SPEND_TOOLS);
export type SpendTool = z.infer<typeof SpendToolSchema>;

/** One spend: what, with which model, for which ferret, and what it cost. Never a prompt, a key or an answer from fal. */
export const SpendRecordSchema = z.strictObject({
  at: z.iso.datetime(),
  /** The spending day in the configured zone at the time, `YYYY-MM-DD`: what the daily cap adds up. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  tool: SpendToolSchema,
  /** The model's short name (`flux-schnell`, `flash`, `sound-effects`, `music`): what the line was spent on. */
  model: z.string().min(1).max(64),
  ferret: z.string().min(1).max(128),
  microUsd: z.number().int().nonnegative(),
  /** Where the price came from: the provider's own price endpoint (fal), or the table in `pricing.ts`. */
  priced: z.enum(['fal', 'table']),
  /** The request's digest, so an owner's approval is spent once and only on the request it was given for. */
  request: z.string().regex(/^[0-9a-f]{16}$/u),
  /**
   * Set on the line that gives back a spend reserved before a run fal definitely did not bill (a refusal, a 4xx): it
   * repeats the reserved line and cancels it in every sum. The ledger is only ever appended to.
   */
  refund: z.literal(true).optional(),
});
export type SpendRecord = z.infer<typeof SpendRecordSchema>;

export const SPEND_LEDGER = defineState({
  name: 'ledger',
  path: 'ledger.jsonl',
  store: 'jsonl',
  format: 1,
  schema: SpendRecordSchema,
  mode: 0o600,
});

// ─── the tool ────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_PROMPT_CHARS = 2_000;

export const GenerateImageInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
  model: ImageModelIdSchema.default(DEFAULT_IMAGE_MODEL),
  size: ImageSizeIdSchema.default(DEFAULT_IMAGE_SIZE),
});
export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>;

const SecondsSchema = (min: number, max: number, fallback: number) => z.number().min(min).max(max).default(fallback);

/** A voiceover: the text to read, the ElevenLabs voice (a premade id) and the model. */
export const GenerateSpeechInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(MAX_SPEECH_CHARS),
  voice: z
    .string()
    .regex(/^[A-Za-z0-9]{10,40}$/u, 'voice is an ElevenLabs voice id: letters and digits only')
    .default(DEFAULT_VOICE_ID),
  model: SpeechModelIdSchema.default(DEFAULT_SPEECH_MODEL),
});
export type GenerateSpeechInput = z.infer<typeof GenerateSpeechInputSchema>;

/** One sound effect: a description and how long it is (billed by the second, so the length is part of the request). */
export const GenerateSfxInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(500),
  seconds: SecondsSchema(MIN_SFX_SECONDS, MAX_SFX_SECONDS, DEFAULT_SFX_SECONDS),
});
export type GenerateSfxInput = z.infer<typeof GenerateSfxInputSchema>;

/** A short piece of music: billed by the minute rounded up, so a 10 s jingle costs what a 60 s one does. */
export const GenerateMusicInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
  seconds: z.number().int().min(MIN_MUSIC_SECONDS).max(MAX_MUSIC_SECONDS).default(DEFAULT_MUSIC_SECONDS),
  instrumental: z.boolean().default(false),
});
export type GenerateMusicInput = z.infer<typeof GenerateMusicInputSchema>;

/** A clip: a description, the model, its length and shape, and whether it has sound (which doubles the price). */
export const GenerateVideoInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
  model: VideoModelIdSchema.default(DEFAULT_VIDEO_MODEL),
  /** Absent: the model's own default length. The lengths each model takes are in `VIDEO_MODELS`. */
  seconds: z.number().int().positive().optional(),
  aspect: VideoAspectSchema.default(DEFAULT_VIDEO_ASPECT),
  /** Veo only: Kling's resolution is fixed. */
  resolution: VideoResolutionSchema.optional(),
  /** Sound is OFF unless asked for: it doubles the price. */
  audio: z.boolean().default(false),
});
export type GenerateVideoInput = z.infer<typeof GenerateVideoInputSchema>;

/** The job a clip was queued as: what `generate_video` answered and `generation_status` takes. */
export const JOB_ID_PATTERN = /^vid_[0-9a-f]{12}$/u;
export const GenerationStatusInputSchema = z.strictObject({
  job: z.string().regex(JOB_ID_PATTERN, 'job is the id generate_video answered, like vid_0123456789ab'),
});
export type GenerationStatusInput = z.infer<typeof GenerationStatusInputSchema>;

// ─── the video jobs (state/create/jobs.jsonl) ────────────────────────────────────────────────────────────────────

/** fal's queue addresses for one request: https on `queue.fal.run` and nowhere else (the kernel only places the key there). */
export const FAL_QUEUE_HOST = 'queue.fal.run';
export const isFalQueueUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' && parsed.host === FAL_QUEUE_HOST && parsed.username === '' && parsed.password === ''
    );
  } catch {
    return false;
  }
};
const QueueUrlSchema = z
  .string()
  .max(2048)
  .refine(isFalQueueUrl, { message: 'a queue address is https on queue.fal.run' });

/**
 * What is kept of a queued clip so a restart loses nothing and charges nothing twice. The file is only ever appended
 * to: a job is its `submitted` line plus at most ONE `finished` line. Never a key, never fal's answer, never the
 * prompt (the one-line `alt` the chat block needs is kept; the file is private to the owner).
 */
export const JobRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('submitted'),
    job: z.string().regex(JOB_ID_PATTERN),
    at: z.iso.datetime(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    ferret: z.string().min(1).max(128),
    model: z.string().min(1).max(64),
    request: z.string().regex(/^[0-9a-f]{16}$/u),
    microUsd: z.number().int().nonnegative(),
    priced: z.enum(['fal', 'table']),
    falRequest: z.string().min(1).max(128),
    statusUrl: QueueUrlSchema,
    resultUrl: QueueUrlSchema,
    /** The cost line and the sentence for "paid for", as they were when it was paid. */
    costLine: z.string().max(400),
    paid: z.string().max(400),
    alt: z.string().max(200),
    label: z.string().max(200),
  }),
  /** One read of a made clip (its result, or its file on fal's storage) that failed. Only a count: after a few, the job is closed as counted. */
  z.strictObject({
    kind: z.literal('unread'),
    job: z.string().regex(JOB_ID_PATTERN),
    at: z.iso.datetime(),
  }),
  z.strictObject({
    kind: z.literal('finished'),
    job: z.string().regex(JOB_ID_PATTERN),
    at: z.iso.datetime(),
    /** `delivered`: the file is in the media folder. `refunded`: fal failed it with an error it does not bill (a 5xx class, or a bad request). `counted`: it failed or was lost and may have been billed. */
    outcome: z.enum(['delivered', 'refunded', 'counted']),
    /** What to tell the ferret on any later call: the media name (delivered) or the sentence (the others). */
    where: z.string().max(300).optional(),
    bytes: z.number().int().nonnegative().optional(),
    sentence: z.string().max(400).optional(),
  }),
]);
export type JobRecord = z.infer<typeof JobRecordSchema>;

export const VIDEO_JOBS = defineState({
  name: 'jobs',
  path: 'jobs.jsonl',
  store: 'jsonl',
  format: 1,
  schema: JobRecordSchema,
  mode: 0o600,
});

/** What Chat shows inline: the media folder's own image bound (docs/fy-render.md rule 11). */
export const MAX_CHAT_IMAGE_BYTES = 1024 * 1024;
/** The same bound for sound: the session media folder's own, which a player in the chat reads (docs/fy-render.md rule 11). */
export const MAX_CHAT_MEDIA_BYTES = 1024 * 1024;

// ─── the ask over the limit ──────────────────────────────────────────────────────────────────────────────────────

/** The ask source Create registers (`ask.sources:create-spend`): one ask per dear call, answered Approve or Reject. */
export const CREATE_SPEND_SOURCE = 'create-spend';
export const CreateSpendRefSchema = z.strictObject({
  tool: SpendToolSchema,
  request: z.string().regex(/^[0-9a-f]{16}$/u),
});

// ─── policy ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const CREATE_AUDIT = audit('create.generated');
export const CREATE_GUARD = {
  none: 'a price, a model name and a picture’s path; never a key, a prompt’s hidden text or a body fal or ElevenLabs sent',
} as const;
