import { SocketEndpointSchema } from '@ferretry/relay';
import { z } from 'zod';
import { normalizeAnalyticsModelIdentity } from '../analytics/model-identity.ts';
import type { AnalyticsPricingRate } from '../analytics/pricing.ts';

const HostSchema = z.string().trim().min(1).max(255);
const PortSchema = z.number().int().min(1).max(65_535);
const CorsOriginSchema = z
  .url()
  .refine(value => {
    const origin = new URL(value).origin;
    return value === origin || value === `${origin}/`;
  }, 'CORS entry must be an origin without a path, query, or fragment')
  .transform(value => new URL(value).origin);

const UsdMicrosPerMillionSchema = z.number().int().nonnegative().safe();
const PricingRatesSchema = z
  .object({
    input: UsdMicrosPerMillionSchema,
    cachedRead: UsdMicrosPerMillionSchema,
    cacheWrite: UsdMicrosPerMillionSchema.optional(),
    cacheWrite5m: UsdMicrosPerMillionSchema.optional(),
    cacheWrite1h: UsdMicrosPerMillionSchema.optional(),
    output: UsdMicrosPerMillionSchema,
  })
  .strict();

const InstantSchema = z
  .string()
  .trim()
  .refine(value => Number.isFinite(Date.parse(value)), 'must be a valid instant');

const PricingRateSchema = z
  .object({
    /** A stable operator-chosen reference, retained on every priced usage snapshot. */
    pricingKey: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    aliases: z.array(z.string().trim().min(1)).readonly().default([]),
    provider: z.enum(['openai', 'anthropic']),
    /** Integer USD micros per million tokens; do not use floating-point dollars. */
    ratesUsdMicrosPerMillion: PricingRatesSchema,
    /** When the operator last checked this price against its authoritative source. */
    verifiedAt: InstantSchema,
    validFrom: InstantSchema,
    validThrough: InstantSchema.optional(),
  })
  .strict()
  .superRefine((rate, context) => {
    if (rate.validThrough !== undefined && Date.parse(rate.validThrough) < Date.parse(rate.validFrom)) {
      context.addIssue({ code: 'custom', path: ['validThrough'], message: 'must not precede validFrom' });
    }
  });

/**
 * Operator-owned per-model prices for this daemon only. The empty default is
 * intentional: a daemon must report a missing price as unpriced, never guess
 * from a public table or turn absence into a zero-cost result.
 */
export const AnalyticsPricingCatalogSchema = z
  .array(PricingRateSchema)
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

export type AnalyticsPricingCatalog = readonly AnalyticsPricingRate[];

/**
 * Where the daemon reads account health from.
 *
 * Both sources are optional and tried in order. Neither is defaulted to a particular tool or
 * address: the source hardcoded one collector's name and flags into the daemon, so a host that ran
 * anything else had no fallback at all and no way to configure one.
 */
export const UsageFeedConfigSchema = z
  .object({
    /** The fleet collector's JSON usage endpoint. */
    url: z.url().optional(),
    /**
     * Fallback command for hosts where the collector is not listening, as argv. The daemon appends
     * the flags it needs (see `USAGE_PROBE_FLAGS`); an empty list means there is no fallback.
     */
    fallbackCommand: z.array(z.string().trim().min(1)).readonly().default([]),
    /** How long one collected snapshot is served before the feed refreshes it. */
    refreshSeconds: z.number().int().positive().default(300),
  })
  .strict();

export type UsageFeedConfig = z.output<typeof UsageFeedConfigSchema>;

/**
 * The rendezvous this daemon dials out to, so a browser can reach it without an inbound route.
 *
 * THE DAEMON DIALS. Nothing ever connects inward to a daemon on `127.0.0.1`, which is the whole
 * reason a relay makes one reachable at all: the socket is opened from behind the NAT, and the
 * rendezvous only ever answers on a connection the daemon already made.
 *
 * THERE IS NO DEFAULT ADDRESS, and the block itself is optional. An absent block means this daemon
 * has no relay carrier — never "use the one everybody uses". The relay protocol keeps no compiled
 * carrier constant on either end (§1 of `docs/relay-protocol.md`), and inventing one here would put
 * the daemon half of that contract in a release rather than in configuration.
 *
 * `url` IS PART OF THE SIGNATURE. The claim transcript covers the host the daemon believes it is
 * talking to, so this string has to be the one the rendezvous serves itself as; a daemon refuses to
 * sign a host it did not configure. Both ends being pointed at the same spelling is the requirement
 * `describeConnectionMethod` already discloses to the person configuring it.
 */
export const DaemonRelayConfigSchema = z
  .object({
    /** The rendezvous origin, as `SocketEndpointSchema` spells one: secure everywhere, insecure
     *  only against loopback, and no query or fragment. */
    url: SocketEndpointSchema,
    /** Whether to dial at all. A configured address the operator has switched off stays readable
     *  rather than having to be deleted and retyped. */
    enabled: z.boolean().default(true),
    /** How long to wait before dialling again after a socket ends. A rendezvous holds the incumbent
     *  daemon's slot until its dead socket is swept — at most 45 seconds — so a redial that is faster
     *  than the sweep is refused with `4409` rather than being granted early. */
    reconnectSeconds: z.number().int().positive().max(3_600).default(5),
  })
  .strict();

export type DaemonRelayConfig = z.output<typeof DaemonRelayConfigSchema>;

export const DaemonConfigSchema = z
  .object({
    host: HostSchema.default('127.0.0.1'),
    port: PortSchema.default(7337),
    publicUrl: z.url().optional(),
    /** Exact browser origins allowed to call this daemon, including the public pairing exchange. */
    corsOrigins: z.array(CorsOriginSchema).max(32).readonly().default(['https://ferretry.pages.dev']),
    secretsFile: z.string().trim().min(1).optional(),
    healthIntervalSeconds: z.number().int().positive().default(30),
    transcriptReconcileSeconds: z.number().int().positive().default(2),
    usage: UsageFeedConfigSchema.prefault({}),
    /** The rendezvous carrier, if this host has one. Absent means direct-only. */
    relay: DaemonRelayConfigSchema.optional(),
    /**
     * Prices the operator has personally supplied for this daemon's usage.
     * These are API-equivalent rates, not a statement of subscription spend.
     */
    analyticsPricing: AnalyticsPricingCatalogSchema.default([]),
    projectRoots: z.array(z.string().trim().min(1)).readonly().default(['~/Workspace', '~/.config']),
  })
  .strict()
  .transform(value => ({ ...value, publicUrl: value.publicUrl ?? `http://${value.host}:${value.port}` }));

export type DaemonConfig = z.output<typeof DaemonConfigSchema>;

/** Parses a complete configuration document and derives its canonical public URL. */
export function parseDaemonConfig(value: unknown): DaemonConfig {
  return DaemonConfigSchema.parse(value);
}

export function defaultDaemonConfig(): DaemonConfig {
  return parseDaemonConfig({});
}
