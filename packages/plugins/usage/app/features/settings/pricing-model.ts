/**
 * THE PRICING PAGE'S PURE PARTS: the draft a manual rate is typed into, how it becomes a rate the protocol accepts,
 * the words each maker / rate slot / unit is shown with, and how a failed call is told. No React here.
 */
import {
  ANALYTICS_PRICING_RATE_SLOTS,
  type AnalyticsPricingProvider,
  type AnalyticsPricingRate,
  type AnalyticsPricingRateSlot,
  type AnalyticsPricingRateUnit,
  type AnalyticsPricingView,
  ManualAnalyticsPricingRateSchema,
} from '../../../contract/index.ts';
import { viewerTime } from '@ferretry/app';
import { DaemonCallError } from '../../shell.ts';

export type PricingLoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly view: AnalyticsPricingView }
  | { readonly status: 'failed'; readonly message: string };

export interface PricingDraft {
  readonly pricingKey: string;
  readonly modelId: string;
  readonly aliases: string;
  readonly provider: AnalyticsPricingProvider;
  readonly validFrom: string;
  readonly validThrough: string;
  readonly verifiedAt: string;
  readonly rates: Readonly<Record<AnalyticsPricingRateSlot, string>>;
}

export type PricingFieldErrors = Readonly<Record<string, string>>;

/** Each maker as a person reads it; a maker the protocol adds without a label here does not compile. */
export const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
  zai: 'Z.ai (GLM)',
  minimax: 'MiniMax',
  alibaba: 'Alibaba (Qwen)',
} as const satisfies Readonly<Record<AnalyticsPricingProvider, string>>;

export const RATE_LABELS = {
  input: 'Input',
  output: 'Output',
  cachedInput: 'Cached input',
  cacheWrite: 'Cache write',
  cacheWrite5m: 'Cache write · 5m',
  cacheWrite1h: 'Cache write · 1h',
  reasoning: 'Reasoning',
  image: 'Image',
  tool: 'Tool',
} as const satisfies { readonly [Slot in AnalyticsPricingRateSlot]: string };

export const UNIT_LABELS = {
  million_tokens: 'million tokens',
  image: 'image',
  tool_call: 'tool call',
} as const satisfies Readonly<Record<AnalyticsPricingRateUnit, string>>;

const EMPTY_RATES = Object.fromEntries(ANALYTICS_PRICING_RATE_SLOTS.map(slot => [slot, ''])) as Readonly<
  Record<AnalyticsPricingRateSlot, string>
>;

export const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.trim() !== '' ? error.message : 'The daemon did not answer this request.';

const isHttpCode = (error: unknown, ...codes: readonly string[]): boolean =>
  error instanceof DaemonCallError && error.code !== undefined && codes.includes(error.code);

export const isCatalogConflict = (error: unknown): boolean =>
  isHttpCode(error, 'pricing_stale_catalog', 'pricing_stale_sources');

export const isPreviewConflict = (error: unknown): boolean =>
  isHttpCode(
    error,
    'pricing_stale_catalog',
    'pricing_stale_sources',
    'pricing_unknown_preview',
    'pricing_expired_preview',
    'pricing_preview_mismatch',
  );

/** A rate's date on the viewer's own clock, the zone named (never the daemon's UTC spelling). */
export const formatInstant = (instant: string): string => viewerTime(instant);

export const formatUsdMicros = (micros: number): string => {
  const whole = Math.floor(micros / 1_000_000);
  const remainder = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '');
  return remainder === '' ? `$${whole}` : `$${whole}.${remainder}`;
};

const draftAmount = (micros: number | null): string => {
  if (micros === null) return '';
  const whole = Math.floor(micros / 1_000_000);
  const remainder = String(micros % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/u, '');
  return remainder === '' ? String(whole) : `${whole}.${remainder}`;
};

export const blankDraft = (): PricingDraft => ({
  pricingKey: '',
  modelId: '',
  aliases: '',
  provider: 'openai',
  validFrom: '',
  validThrough: '',
  verifiedAt: '',
  rates: EMPTY_RATES,
});

export const rateDraft = (rate: AnalyticsPricingRate): PricingDraft => ({
  pricingKey: rate.pricingKey,
  modelId: rate.modelId,
  aliases: rate.aliases.join(', '),
  provider: rate.provider,
  validFrom: rate.validFrom,
  validThrough: rate.validThrough ?? '',
  verifiedAt: rate.verifiedAt,
  rates: Object.fromEntries(
    ANALYTICS_PRICING_RATE_SLOTS.map(slot => [slot, draftAmount(rate.rates[slot])]),
  ) as Readonly<Record<AnalyticsPricingRateSlot, string>>,
});

const parseUsdMicros = (value: string): number | null | undefined => {
  const normalized = value.trim();
  if (normalized === '') return null;
  const match = /^(\d+)(?:\.(\d{1,6}))?$/u.exec(normalized);
  if (match === null) return undefined;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'));
  const micros = whole * 1_000_000n + fraction;
  return micros > BigInt(Number.MAX_SAFE_INTEGER) ? undefined : Number(micros);
};

const fieldForIssue = (path: readonly PropertyKey[]): string => {
  if (path[0] === 'rates' && typeof path[1] === 'string') return `rates.${path[1]}`;
  if (path[0] === 'aliases') return 'aliases';
  return typeof path[0] === 'string' ? path[0] : 'form';
};

export const draftRate = (
  draft: PricingDraft,
): { readonly rate?: AnalyticsPricingRate; readonly errors: PricingFieldErrors } => {
  const errors: Record<string, string> = {};
  const rates = Object.fromEntries(
    ANALYTICS_PRICING_RATE_SLOTS.map(slot => {
      const parsed = parseUsdMicros(draft.rates[slot]);
      if (parsed === undefined) {
        errors[`rates.${slot}`] = 'Enter a non-negative USD amount with no more than six decimal places.';
        return [slot, null];
      }
      return [slot, parsed];
    }),
  );
  const parsed = ManualAnalyticsPricingRateSchema.safeParse({
    pricingKey: draft.pricingKey,
    modelId: draft.modelId,
    aliases: draft.aliases
      .split(',')
      .map(alias => alias.trim())
      .filter(alias => alias !== ''),
    provider: draft.provider,
    currency: 'USD',
    rates,
    source: { kind: 'manual' },
    validFrom: draft.validFrom,
    validThrough: draft.validThrough.trim() === '' ? null : draft.validThrough,
    verifiedAt: draft.verifiedAt,
    lastSyncedAt: null,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap(issue =>
      issue.code === 'invalid_union' ? (issue.errors[0] ?? []) : [issue],
    );
    for (const issue of issues) {
      const field = fieldForIssue(issue.path);
      if (errors[field] === undefined) errors[field] = issue.message;
    }
    return { errors };
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { rate: parsed.data, errors };
};
