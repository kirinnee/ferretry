/**
 * `@ferretry/plugin-create/contract`: creative tools for agents that cannot make media themselves. This unit holds
 * the core every later tool stands on (pricing, the spend ledger, the daily cap, the ask over a limit) and the first
 * tool, `generate_image`. The wire contract is docs/create.md.
 */
import { audit } from '@ferretry/core-gate/contract';
import { type ConfigDef, defineConfig, defineState } from '@ferretry/kernel/contract';
import type { Word } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_SIZE, ImageModelIdSchema, ImageSizeIdSchema } from './pricing.ts';

export * from './pricing.ts';

export const CREATE_WORDS: readonly Word[] = [
  { word: 'creative tool', means: 'an agent tool that makes an image, sound or video by calling a paid service' },
];

// ─── the key and the limits (config/create.yaml) ─────────────────────────────────────────────────────────────────

/** The ONE spelling `fal.key` takes: a reference to the secret the manifest declares, never a value. */
export const FAL_KEY_REFERENCE = '${secret:FAL_KEY}';

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

/** One spend: what, with which model, for which ferret, and what it cost. Never a prompt, a key or an answer from fal. */
export const SpendRecordSchema = z.strictObject({
  at: z.iso.datetime(),
  /** The spending day in the configured zone at the time, `YYYY-MM-DD`: what the daily cap adds up. */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  tool: z.literal('generate_image'),
  model: ImageModelIdSchema,
  ferret: z.string().min(1).max(128),
  microUsd: z.number().int().nonnegative(),
  /** Where the price came from: fal's own endpoint, or the table in `pricing.ts`. */
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

/** What Chat shows inline: the media folder's own image bound (docs/fy-render.md rule 11). */
export const MAX_CHAT_IMAGE_BYTES = 1024 * 1024;

// ─── the ask over the limit ──────────────────────────────────────────────────────────────────────────────────────

/** The ask source Create registers (`ask.sources:create-spend`): one ask per dear call, answered Approve or Reject. */
export const CREATE_SPEND_SOURCE = 'create-spend';
export const CreateSpendRefSchema = z.strictObject({
  tool: z.literal('generate_image'),
  request: z.string().regex(/^[0-9a-f]{16}$/u),
});

// ─── policy ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const CREATE_AUDIT = audit('create.generated');
export const CREATE_GUARD = {
  none: 'a price, a model name and a picture’s path; never a key, a prompt’s hidden text or a body fal sent',
} as const;
