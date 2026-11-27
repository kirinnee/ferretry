/**
 * HeyGen avatar video: the key's one spelling, the two tools' inputs, the job file and the price. HeyGen has no price
 * endpoint, so the table here is the whole price (always `table`); it is deliberately generous (a started minute is
 * charged whole, and the speaking time is estimated high), so the estimate is never under the bill.
 */
import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { MicroUsd, Priced } from './pricing.ts';

/** The ONE spelling `heygen.key` takes: a reference to the secret the manifest declares, never a value. */
export const HEYGEN_KEY_REFERENCE = '${secret:HEYGEN_API_KEY}';

export const HEYGEN_API_HOST = 'api.heygen.com';

/**
 * HeyGen's own storage for a made video (`video_url` of a finished job). It is fetched with NO key and over https only,
 * so a wildcard (which the kernel never lets a key reach) is enough.
 */
export const isHeygenCdn = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      (host.endsWith('.heygen.ai') || host.endsWith('.heygen.com'))
    );
  } catch {
    return false;
  }
};

export const MAX_AVATAR_SCRIPT_CHARS = 1_500;

export const AVATAR_ASPECTS = ['16:9', '9:16'] as const;
export const AvatarAspectSchema = z.enum(AVATAR_ASPECTS);
/** The frame each shape is asked for, in pixels (720p: what every HeyGen plan can render). */
export const AVATAR_DIMENSIONS = Object.freeze({
  '16:9': { width: 1280, height: 720 },
  '9:16': { width: 720, height: 1280 },
} as const);

/** An avatar and a voice are the owner's own HeyGen ids: there is no default, so none is ever invented for them. */
export const GenerateAvatarVideoInputSchema = z.strictObject({
  script: z.string().trim().min(1).max(MAX_AVATAR_SCRIPT_CHARS),
  avatar: z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u, 'avatar is a HeyGen avatar id: letters, digits, _ and - only'),
  voice: z.string().regex(/^[A-Za-z0-9]{10,64}$/u, 'voice is a HeyGen voice id: letters and digits only'),
  aspect: AvatarAspectSchema.default('16:9'),
});
export type GenerateAvatarVideoInput = z.infer<typeof GenerateAvatarVideoInputSchema>;

export const AVATAR_JOB_ID_PATTERN = /^avt_[0-9a-f]{12}$/u;
export const AvatarVideoStatusInputSchema = z.strictObject({
  job: z.string().regex(AVATAR_JOB_ID_PATTERN, 'job is the id generate_avatar_video answered, like avt_0123456789ab'),
});

// ─── the price ───────────────────────────────────────────────────────────────────────────────────────────────────

/** HeyGen API credits come to about one dollar per minute of avatar video on the API plans; every started minute is charged whole. */
export const AVATAR_TABLE_MICRO_USD_PER_MINUTE: MicroUsd = 1_000_000;
/** Speaking pace the length is guessed from: about 15 characters a second (150 words a minute). The guess is high-side by rounding up. */
export const AVATAR_CHARS_PER_SECOND = 15;
export const AVATAR_PRICE_SOURCE =
  'https://www.heygen.com/api-pricing (about $1 per started minute of avatar video; plan dependent, an estimate, not an invoice)';

/** The cost of a script: its speaking time guessed from its length, rounded up to whole minutes, never under one. */
export function priceAvatarVideo(script: string): Priced {
  const seconds = Math.ceil([...script].length / AVATAR_CHARS_PER_SECOND);
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return { ok: true, microUsd: minutes * AVATAR_TABLE_MICRO_USD_PER_MINUTE, from: 'table' };
}

// ─── the job file (state/create/avatar-jobs.jsonl) ───────────────────────────────────────────────────────────────

/**
 * What is kept of a queued avatar video so a restart loses nothing and charges nothing twice. Only ever appended to: a
 * job is its `submitted` line plus at most ONE `finished` line. Never a key, never HeyGen's answer, never the script
 * (the one-line `alt` the chat block needs is kept; the file is private to the owner).
 */
export const AvatarJobRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('submitted'),
    job: z.string().regex(AVATAR_JOB_ID_PATTERN),
    at: z.iso.datetime(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    ferret: z.string().min(1).max(128),
    request: z.string().regex(/^[0-9a-f]{16}$/u),
    microUsd: z.number().int().nonnegative(),
    /** HeyGen's id for the video: what the status is asked by. */
    heygenVideo: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u),
    costLine: z.string().max(400),
    paid: z.string().max(400),
    alt: z.string().max(200),
    label: z.string().max(200),
  }),
  z.strictObject({
    kind: z.literal('finished'),
    job: z.string().regex(AVATAR_JOB_ID_PATTERN),
    at: z.iso.datetime(),
    /** `delivered`: the file is in the media folder. `counted`: it failed or could not be fetched and may have been billed (HeyGen documents no refund Create can rely on). */
    outcome: z.enum(['delivered', 'counted']),
    where: z.string().max(300).optional(),
    sentence: z.string().max(400).optional(),
  }),
]);
export type AvatarJobRecord = z.infer<typeof AvatarJobRecordSchema>;

export const AVATAR_JOBS = defineState({
  name: 'avatar-jobs',
  path: 'avatar-jobs.jsonl',
  store: 'jsonl',
  format: 1,
  schema: AvatarJobRecordSchema,
  mode: 0o600,
});
