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
export type FalUnit = 'megapixel' | 'image';

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
  const lower = text.toLowerCase();
  if (lower.includes('megapixel')) return 'megapixel';
  if (lower === 'image' || lower === 'images') return 'image';
  return undefined;
};

/**
 * The cost of ONE image of this size on this model, rounded UP to a micro-dollar. A megapixel rate is proportional
 * to the output's area; a per-image rate is flat, but a picture over one megapixel is priced as that many, so the
 * estimate is never below what a per-megapixel bill would be. A live rate in a unit this file cannot price is
 * REFUSED, never guessed: a price the owner was not shown is not spent.
 */
export function priceImage(model: ImageModel, size: ImageSizeId, live?: LiveRate): Priced {
  const { width, height } = IMAGE_SIZES[size];
  const megapixels = (width * height) / 1_000_000;
  const rate =
    live === undefined
      ? { unit: model.unit as FalUnit | undefined, microUsd: model.tableMicroUsd, from: 'table' as const }
      : { unit: unitOf(live.unit), microUsd: live.unitPrice * 1_000_000, from: 'fal' as const };
  if (rate.unit === undefined || !Number.isFinite(rate.microUsd) || rate.microUsd < 0)
    return { ok: false, why: `fal prices ${model.endpoint} in a unit Create cannot price, so nothing was sent` };
  const area = rate.unit === 'megapixel' ? megapixels : Math.max(1, megapixels);
  return { ok: true, microUsd: Math.ceil(rate.microUsd * area), from: rate.from };
}
