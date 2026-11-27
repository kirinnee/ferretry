/**
 * HeyGen avatar video: the key's one spelling, the two tools' inputs, the job file and the price. HeyGen has no price
 * endpoint, so the table here is the whole price (always `table`). HeyGen bills per generated second and per engine, so
 * the request PINS the engine and the price is that engine's published per-second rate on the estimated duration,
 * rounded up. The estimate is an upper bound (a slow speaking rate plus a fixed allowance), so a reservation never undercounts
 * and the ask threshold cannot be skipped; once HeyGen reports the real length the reservation is settled to it.
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
/** What every video is asked for: 720p (what every HeyGen plan can render), in the shape the ferret chose. */
export const AVATAR_RESOLUTION = '720p';
/**
 * The engine EVERY request names (`engine: { type }` on `POST /v3/videos`). HeyGen's default is also Avatar IV, but a
 * default can move; naming it keeps the price reserved the price of the engine that renders, and it serves photo and
 * video avatars alike (Avatar III's `avatar_iii` is cheaper but cannot take every look).
 */
export const AVATAR_ENGINE = 'avatar_iv';

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

/**
 * Avatar IV, charged by the actual seconds generated: $4.83 a minute for a digital twin or studio avatar, $2.31 for a photo
 * avatar. Create does not know which kind the owner's avatar id is, so it reserves the dearer, per second: $4.83 / 60.
 */
export const AVATAR_IV_MICRO_USD_PER_SECOND: MicroUsd = 80_500;
/**
 * The slowest pace a script is assumed to be spoken at: 10 characters a second (about 100 words a minute, slower than a
 * deliberate presenter). The reservation is an UPPER BOUND on the seconds HeyGen will bill, because it is made before the
 * video exists and a gate that undercounts is a gate that can be skipped. A faster read only makes the video shorter and
 * the reservation is settled down to the length HeyGen reports.
 */
export const AVATAR_SLOWEST_CHARS_PER_SECOND = 10;
/** Silence HeyGen adds around the speech (a lead-in and a tail), whole seconds, on top of the speaking time. */
export const AVATAR_PADDING_SECONDS = 3;
export const AVATAR_PRICE_SOURCE =
  'https://help.heygen.com/en/articles/10060327-heygen-api-pricing-credits-explained (Avatar IV, up to $4.83 a minute billed by the second; an estimate, not an invoice)';

/** The most seconds a script can take: its speaking time at the slowest pace plus the padding, rounded UP to whole seconds. */
export const avatarSecondsUpperBound = (script: string): number =>
  Math.ceil([...script].length / AVATAR_SLOWEST_CHARS_PER_SECOND) + AVATAR_PADDING_SECONDS;

/** What `seconds` of video cost at Avatar IV's per-second rate; HeyGen bills whole seconds, so a fraction counts as the next. */
export const avatarCostOf = (seconds: number): MicroUsd => Math.ceil(seconds) * AVATAR_IV_MICRO_USD_PER_SECOND;

/** The cost reserved for a script: the upper bound on its seconds, at Avatar IV's per-second rate. */
export function priceAvatarVideo(script: string): Priced {
  return { ok: true, microUsd: avatarCostOf(avatarSecondsUpperBound(script)), from: 'table' };
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
    /** A delivered video's length as HeyGen reported it, and the cost it was settled to. */
    seconds: z.number().positive().optional(),
    settledMicroUsd: z.number().int().nonnegative().optional(),
    /** Set when HeyGen billed MORE than was reserved: the excess, recorded in the ledger as an overrun and counted toward the daily cap. */
    overrunMicroUsd: z.number().int().positive().optional(),
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
