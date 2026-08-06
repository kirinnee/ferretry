import { z } from 'zod';
import { normalizeAnalyticsModelIdentity } from './analytics-model-identity.ts';
import { InstantSchema, NonEmptyStringSchema } from './common.ts';

/**
 * What a model costs, decided once for every program that reads, edits or applies a price.
 *
 * A CATALOG IS NOT A DAEMON-ONLY FILE. The daemon parses it out of `config/daemon.json`, the browser
 * renders it, edits it and previews a provider's replacement for it, and both ends have to agree on
 * what a valid entry is — down to which slot is denominated in what. Two validators would each pass
 * their own fixture and disagree only in front of an operator, which is the whole failure this module
 * exists to make impossible.
 *
 * ABSENCE IS WRITTEN DOWN, NEVER DEFAULTED. Every rate slot is present and a price nobody has
 * supplied is an explicit `null`; nothing here ever falls back to zero. A missing price has to stay
 * distinguishable from a free one, because "unpriced" is a result an operator can act on and
 * "$0.00" is a lie that reconciles.
 */

export const ANALYTICS_PRICING_PROVIDERS = ['openai', 'anthropic'] as const;
export const AnalyticsPricingProviderSchema = z.enum(ANALYTICS_PRICING_PROVIDERS);
export type AnalyticsPricingProvider = z.infer<typeof AnalyticsPricingProviderSchema>;

/**
 * The only currency this contract expresses, stated on every rate rather than assumed.
 *
 * A literal rather than an open string: a catalog carrying `EUR` amounts that nothing converts would
 * total up and render as dollars, and the operator would have no way to see it happened.
 */
export const AnalyticsPricingCurrencySchema = z.literal('USD');
export type AnalyticsPricingCurrency = z.infer<typeof AnalyticsPricingCurrencySchema>;

export const AnalyticsPricingRateUnitSchema = z.enum(['million_tokens', 'image', 'tool_call']);
export type AnalyticsPricingRateUnit = z.infer<typeof AnalyticsPricingRateUnitSchema>;

/** Integer USD micros. Integers, because a rate table summed in floating-point dollars does not add up. */
const UsdMicrosSchema = z.number().int().nonnegative().safe();

/**
 * Every priced slot, always present.
 *
 * TOTAL ON PURPOSE. An optional key answers "the operator did not say" and "this model has no such
 * charge" with the same silence, and the second is a fact worth recording. Required
 * `input`/`output`/`cachedInput` are the three every supported provider charges for; the specialized
 * slots are nullable so an entry states, in the document, that the charge does not apply.
 */
export const AnalyticsPricingRatesSchema = z.strictObject({
  input: UsdMicrosSchema,
  output: UsdMicrosSchema,
  cachedInput: UsdMicrosSchema,
  cacheWrite: UsdMicrosSchema.nullable(),
  cacheWrite5m: UsdMicrosSchema.nullable(),
  cacheWrite1h: UsdMicrosSchema.nullable(),
  reasoning: UsdMicrosSchema.nullable(),
  image: UsdMicrosSchema.nullable(),
  tool: UsdMicrosSchema.nullable(),
});
export type AnalyticsPricingRates = z.infer<typeof AnalyticsPricingRatesSchema>;
export type AnalyticsPricingRateSlot = keyof AnalyticsPricingRates;

/**
 * What each slot's amount is denominated in — one owner, and a compile error when a slot has none.
 *
 * THE UNIT BELONGS TO THE SLOT, NOT TO THE VALUE. Writing the unit beside every authored amount
 * would let a document say `image` costs `million_tokens`, and then two answers to "how do I multiply
 * this" would exist with nothing able to notice. A slot's denomination is a property of the contract,
 * so it is declared once here and read by both ends; the mapped type below makes a new slot without a
 * unit a compile error at this declaration rather than a rendering surprise later.
 */
export const ANALYTICS_PRICING_RATE_UNITS = {
  input: 'million_tokens',
  output: 'million_tokens',
  cachedInput: 'million_tokens',
  cacheWrite: 'million_tokens',
  cacheWrite5m: 'million_tokens',
  cacheWrite1h: 'million_tokens',
  reasoning: 'million_tokens',
  image: 'image',
  tool: 'tool_call',
} as const satisfies { readonly [K in AnalyticsPricingRateSlot]: AnalyticsPricingRateUnit };

/** Every priced slot, derived from the unit table so a walk over the rates cannot miss a new one. */
export const ANALYTICS_PRICING_RATE_SLOTS = Object.keys(
  ANALYTICS_PRICING_RATE_UNITS,
) as readonly AnalyticsPricingRateSlot[];

/** The denomination a slot's amount is expressed in. Ask this rather than assuming per-million tokens. */
export function analyticsPricingRateUnit(slot: AnalyticsPricingRateSlot): AnalyticsPricingRateUnit {
  return ANALYTICS_PRICING_RATE_UNITS[slot];
}

/** The slots an amount is multiplied by a token count for, derived so a new token slot joins by itself. */
export const ANALYTICS_PRICING_TOKEN_SLOTS = ANALYTICS_PRICING_RATE_SLOTS.filter(
  slot => ANALYTICS_PRICING_RATE_UNITS[slot] === 'million_tokens',
);

/**
 * A bounded address a price may be fetched from — never a place to smuggle a credential.
 *
 * NO USERINFO, NO FRAGMENT, HTTPS ONLY. `https://user:key@example.com/prices` is a secret written
 * into a file that travels into backups and screen shares, which is precisely the journey the secret
 * store exists to prevent. The bound is on the value, not on operator discipline.
 */
export const AnalyticsPricingSourceUrlSchema = z
  .url()
  .max(2_048)
  .superRefine((value, context) => {
    // Checks still run after the format check fails, so a value that is not a URL at all is left to
    // the message `z.url()` already produced rather than parsed again here.
    if (!URL.canParse(value)) return;
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'pricing sources must be fetched over https' });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'pricing source URLs may not carry credentials' });
    }
    if (url.hash !== '') {
      context.addIssue({ code: 'custom', message: 'pricing source URLs may not carry a fragment' });
    }
  });

/**
 * Where an entry's numbers came from, in a shape a reader cannot mistake.
 *
 * MANUAL AND SYNCED ARE MECHANICALLY DIFFERENT, not a boolean beside an optional URL: a provider
 * sync carries the provider and the address it was read from, and a manual override carries neither,
 * so "who last decided this price" is answered by the discriminant rather than by inference.
 */
export const AnalyticsPricingSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manual') }),
  z.strictObject({
    kind: z.literal('provider_sync'),
    provider: AnalyticsPricingProviderSchema,
    sourceUrl: AnalyticsPricingSourceUrlSchema,
  }),
]);
export type AnalyticsPricingSource = z.infer<typeof AnalyticsPricingSourceSchema>;

/**
 * One priced model over one effective window, with the provenance a person needs to trust it.
 *
 * `validThrough` and `lastSyncedAt` are nullable rather than absent for the same reason the rate
 * slots are: an open-ended window and a never-synced entry are facts, and a key that can simply be
 * missing makes them indistinguishable from an unfinished document.
 */
const CanonicalAnalyticsPricingRateSchema = z.strictObject({
  /** A stable operator-chosen reference, retained on every priced usage snapshot. */
  pricingKey: NonEmptyStringSchema.max(128),
  modelId: NonEmptyStringSchema.max(128),
  aliases: z.array(NonEmptyStringSchema.max(128)).max(32).readonly().default([]),
  provider: AnalyticsPricingProviderSchema,
  currency: AnalyticsPricingCurrencySchema,
  rates: AnalyticsPricingRatesSchema,
  source: AnalyticsPricingSourceSchema,
  validFrom: InstantSchema,
  /** Open-ended when null: this price is the current one until another window supersedes it. */
  validThrough: InstantSchema.nullable().default(null),
  /** When a person last checked this price against its authoritative source. */
  verifiedAt: InstantSchema,
  /** When a provider feed last supplied these numbers. Always null for a manual entry. */
  lastSyncedAt: InstantSchema.nullable().default(null),
});

type CanonicalAnalyticsPricingRate = z.infer<typeof CanonicalAnalyticsPricingRateSchema>;

/**
 * The instant domain the previous schema accepted, canonicalized on the way in.
 *
 * It took anything `Date.parse` understood, so `"2026-07-01"` is in operators' files today. Reading
 * it with the strict instant would have been the same refusal in a different place, so this converts
 * rather than rejects and everything downstream still sees one spelling.
 */
const LegacyInstantSchema = z
  .string()
  .trim()
  .refine(value => Number.isFinite(Date.parse(value)), 'must be a valid instant')
  .transform(value => new Date(value).toISOString());

/**
 * The spelling operators already have on disk, read into the canonical one.
 *
 * A CONFIGURATION THAT BOOTED YESTERDAY BOOTS TODAY. The rate table used to be a per-million-token
 * object under `ratesUsdMicrosPerMillion`, and a schema that simply stopped accepting it would refuse
 * the whole document — taking the daemon down over prices, which are not what a daemon is for. This
 * is a second INPUT DOMAIN, not a second validator: it produces the canonical shape and nothing
 * downstream ever sees the old one, so there is still exactly one answer to "what is a valid rate".
 *
 * What it fills in is what the old shape could not say: the currency it always meant, `manual`
 * provenance because nothing synced these, and `null` for the slots it had no way to express. None of
 * those is a guess about a price.
 */
const LegacyAnalyticsPricingRateSchema = z
  .strictObject({
    pricingKey: NonEmptyStringSchema.max(128),
    modelId: NonEmptyStringSchema.max(128),
    aliases: z.array(NonEmptyStringSchema.max(128)).max(32).readonly().default([]),
    provider: AnalyticsPricingProviderSchema,
    ratesUsdMicrosPerMillion: z.strictObject({
      input: UsdMicrosSchema,
      cachedRead: UsdMicrosSchema,
      cacheWrite: UsdMicrosSchema.optional(),
      cacheWrite5m: UsdMicrosSchema.optional(),
      cacheWrite1h: UsdMicrosSchema.optional(),
      output: UsdMicrosSchema,
    }),
    verifiedAt: LegacyInstantSchema,
    validFrom: LegacyInstantSchema,
    validThrough: LegacyInstantSchema.optional(),
  })
  .transform(
    (rate): CanonicalAnalyticsPricingRate => ({
      pricingKey: rate.pricingKey,
      modelId: rate.modelId,
      aliases: rate.aliases,
      provider: rate.provider,
      currency: 'USD',
      rates: {
        input: rate.ratesUsdMicrosPerMillion.input,
        output: rate.ratesUsdMicrosPerMillion.output,
        cachedInput: rate.ratesUsdMicrosPerMillion.cachedRead,
        cacheWrite: rate.ratesUsdMicrosPerMillion.cacheWrite ?? null,
        cacheWrite5m: rate.ratesUsdMicrosPerMillion.cacheWrite5m ?? null,
        cacheWrite1h: rate.ratesUsdMicrosPerMillion.cacheWrite1h ?? null,
        reasoning: null,
        image: null,
        tool: null,
      },
      source: { kind: 'manual' },
      validFrom: rate.validFrom,
      validThrough: rate.validThrough ?? null,
      verifiedAt: rate.verifiedAt,
      lastSyncedAt: null,
    }),
  );

export const AnalyticsPricingRateSchema = z
  .union([CanonicalAnalyticsPricingRateSchema, LegacyAnalyticsPricingRateSchema])
  .superRefine((rate, context) => {
    if (rate.validThrough !== null && Date.parse(rate.validThrough) < Date.parse(rate.validFrom)) {
      context.addIssue({ code: 'custom', path: ['validThrough'], message: 'must not precede validFrom' });
    }
    if (rate.source.kind === 'provider_sync' && rate.source.provider !== rate.provider) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'provider'],
        message: `must match the rate provider ${JSON.stringify(rate.provider)}`,
      });
    }
    // PROVENANCE AND ITS EVIDENCE AGREE, BOTH WAYS. One direction alone leaves the useful half of
    // the claim optional: a row saying it came from a provider feed, with no instant naming when it
    // did, is exactly the row an operator would read as freshly synced and cannot check.
    if (rate.source.kind === 'manual' && rate.lastSyncedAt !== null) {
      context.addIssue({
        code: 'custom',
        path: ['lastSyncedAt'],
        message: 'a manually entered rate was never synced from a provider',
      });
    }
    if (rate.source.kind === 'provider_sync' && rate.lastSyncedAt === null) {
      context.addIssue({
        code: 'custom',
        path: ['lastSyncedAt'],
        message: 'a provider-synced rate must record when it was synced',
      });
    }
    // One cache write, one price. An entry carrying the undifferentiated rate AND a per-duration
    // rate gives the same token two authored answers, and which one applies would then depend on
    // which branch of a caller happened to read it.
    if (rate.rates.cacheWrite !== null && (rate.rates.cacheWrite5m !== null || rate.rates.cacheWrite1h !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['rates', 'cacheWrite'],
        message: 'must be null when a per-duration cache write rate is given',
      });
    }
  });
export type AnalyticsPricingRate = CanonicalAnalyticsPricingRate;

/**
 * Operator-owned per-model prices for one daemon. The empty default is intentional: a daemon must
 * report a missing price as unpriced, never guess from a public table or turn absence into a
 * zero-cost result.
 *
 * The cross-entry rules are here rather than beside the field that holds them, because the browser
 * that edits a catalog has to refuse exactly what the daemon that loads it refuses.
 */
export const AnalyticsPricingCatalogSchema = z
  .array(AnalyticsPricingRateSchema)
  .max(512)
  .readonly()
  .superRefine((catalog, context) => {
    const pricingKeys = new Set<string>();
    const effectiveRates = new Set<string>();
    const aliases = new Map<string, string>();

    for (const [index, rate] of catalog.entries()) {
      if (pricingKeys.has(rate.pricingKey)) {
        context.addIssue({ code: 'custom', path: [index, 'pricingKey'], message: 'must be unique' });
      }
      pricingKeys.add(rate.pricingKey);

      // `modelId` already passed the non-blank string schema above.
      const modelId = normalizeAnalyticsModelIdentity(rate.modelId)?.modelId ?? rate.modelId;
      const effectiveRate = `${modelId}\u0000${rate.validFrom}`;
      if (effectiveRates.has(effectiveRate)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'validFrom'],
          message: 'must be unique for one normalized model',
        });
      }
      effectiveRates.add(effectiveRate);

      for (const spelling of [rate.modelId, ...rate.aliases]) {
        // Each spelling passed the same non-blank string schema as `modelId`.
        const alias = normalizeAnalyticsModelIdentity(spelling)?.modelId ?? spelling;
        const owner = aliases.get(alias);
        if (owner !== undefined && owner !== modelId) {
          context.addIssue({
            code: 'custom',
            path: [index, 'aliases'],
            message: `${JSON.stringify(spelling)} also identifies ${JSON.stringify(owner)}`,
          });
        }
        aliases.set(alias, modelId);
      }
    }
  });
export type AnalyticsPricingCatalog = z.infer<typeof AnalyticsPricingCatalogSchema>;

/**
 * A provider feed the operator has agreed this daemon may read prices from.
 *
 * THE ADDRESS IS CONFIGURED, NOT REQUESTED. A preview later names one of these by `id`; it never
 * submits a URL of its own, so a browser — or anything holding a browser's credential — cannot aim
 * this daemon's fetch at an address the operator never approved.
 */
export const ConfiguredAnalyticsPricingSourceSchema = z.strictObject({
  /** The stable identifier a preview request names. */
  id: NonEmptyStringSchema.max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'must be a plain identifier'),
  provider: AnalyticsPricingProviderSchema,
  url: AnalyticsPricingSourceUrlSchema,
  /** A configured feed the operator has switched off stays readable rather than having to be retyped. */
  enabled: z.boolean().default(true),
});
export type ConfiguredAnalyticsPricingSource = z.infer<typeof ConfiguredAnalyticsPricingSourceSchema>;

export const ConfiguredAnalyticsPricingSourcesSchema = z
  .array(ConfiguredAnalyticsPricingSourceSchema)
  .max(16)
  .readonly()
  .superRefine((sources, context) => {
    const identifiers = new Set<string>();
    for (const [index, source] of sources.entries()) {
      if (identifiers.has(source.id)) {
        context.addIssue({ code: 'custom', path: [index, 'id'], message: 'must be unique' });
      }
      identifiers.add(source.id);
    }
  });
export type ConfiguredAnalyticsPricingSources = z.infer<typeof ConfiguredAnalyticsPricingSourcesSchema>;

/**
 * What a provider's feed is allowed to state — and, by omission, what it is not.
 *
 * A FEED DOES NOT GET TO CLAIM ITS OWN PROVENANCE. There is no `source`, no `lastSyncedAt` and no
 * `provider` field here: the daemon stamps all three from the configured source it chose to fetch,
 * so a document served from anywhere cannot describe itself as an official price from somebody else.
 * `strictObject` is what makes that a refusal rather than a field nobody reads.
 */
export const AnalyticsPricingFeedEntrySchema = z.strictObject({
  pricingKey: NonEmptyStringSchema.max(128),
  modelId: NonEmptyStringSchema.max(128),
  aliases: z.array(NonEmptyStringSchema.max(128)).max(32).readonly().default([]),
  currency: AnalyticsPricingCurrencySchema,
  rates: AnalyticsPricingRatesSchema,
  validFrom: InstantSchema,
  validThrough: InstantSchema.nullable().default(null),
});
export type AnalyticsPricingFeedEntry = z.infer<typeof AnalyticsPricingFeedEntrySchema>;

export const AnalyticsPricingFeedSchema = z.strictObject({
  entries: z.array(AnalyticsPricingFeedEntrySchema).max(512).readonly(),
});
export type AnalyticsPricingFeed = z.infer<typeof AnalyticsPricingFeedSchema>;
