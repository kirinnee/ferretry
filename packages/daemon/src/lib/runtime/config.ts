import { daemonAddress, FY_DEFAULT_DAEMON_PORT } from '@ferretry/protocol';
import { SocketEndpointSchema } from '@ferretry/relay';
import { z } from 'zod';
import type { RunOverrides } from './arguments.ts';
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

/**
 * The document an operator owns: exactly the fields `config/daemon.json` holds, and nothing derived.
 *
 * SEPARATE from the parsed configuration below, because the two are written back to disk very
 * differently. A DEFAULT is a value this deployment picked and an operator may edit — writing it out
 * makes it visible and editable, which is the point. A DERIVATION is a value computed from other
 * fields, and persisting one is a defect: once on disk it stops tracking the field it came from, so
 * the operator edits `port`, the derived `publicUrl` keeps the old number, and the daemon appears to
 * ignore the edit entirely. That is exactly what happened — `port` was a field an operator could
 * change with no error, no message and no change in behaviour, which is worse than the collision it
 * was being changed to escape. So: nothing derived is ever written here, and everything derived is
 * recomputed on every read, which makes disagreement between the two unrepresentable.
 */
export const DaemonConfigDocumentSchema = z
  .object({
    host: HostSchema.default('127.0.0.1'),
    /**
     * The address this daemon owns. OPTIONAL, and the absence means something specific.
     *
     * A recorded port — whether an operator typed it or a first boot wrote down what it took — is a
     * claim on that exact address: it is bound or the boot refuses, because a daemon whose address
     * moves on its own is worse than one that fails, and every client that pinned it would be left
     * looking at nothing. An ABSENT port is the only case where this daemon may choose, and it
     * chooses once and records the answer, so the next boot is back in the first case.
     */
    port: PortSchema.optional(),
    /** The address this daemon is REACHED at, when that is not the address it binds. Operator-owned
     *  and optional: absent means "the same one", and absent is what a written document carries. */
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
  .strict();

export type DaemonConfigDocument = z.output<typeof DaemonConfigDocumentSchema>;

/**
 * The document plus everything derived from it: the port to try, the two addresses, and which of
 * them the document actually recorded.
 *
 * `bindUrl` is what this daemon LISTENS on and is therefore what an incumbent probe must ask: a
 * responder is only this boot's problem when it holds the very socket the bind wants. Probing the
 * advertised URL instead is how a stale advertisement sent a boot to interrogate an unrelated
 * program on a port it was not even going to bind.
 *
 * `publicUrl` is what this daemon is REACHED at, which is the same address unless an operator said
 * otherwise, and it is what pairing links and browser origins carry.
 *
 * The two `…IsRecorded` flags exist because a value's ORIGIN changes what may be done with it, and
 * once derivation happens on every read there is otherwise no way to tell a default from a choice.
 * A recorded port is claimed; an unrecorded one is a preference this boot may move off. A recorded
 * public URL survives a moved port; an unrecorded one follows it.
 */
export const DaemonConfigSchema = DaemonConfigDocumentSchema.transform(value => {
  const port = value.port ?? FY_DEFAULT_DAEMON_PORT;
  const bindUrl = daemonAddress(value.host, port);
  return {
    ...value,
    port,
    portIsRecorded: value.port !== undefined,
    bindUrl,
    publicUrl: value.publicUrl ?? bindUrl,
    publicUrlIsRecorded: value.publicUrl !== undefined,
  };
});

export type DaemonConfig = z.output<typeof DaemonConfigSchema>;

/**
 * The same configuration once a port has actually been decided.
 *
 * It exists so the decision happens BEFORE anything reads an address. Pairing links, browser origins
 * and the advertised URL are all assembled from this document while the subsystems are built, and a
 * boot that only learned its real port at bind time would have handed every one of them the port it
 * did not take. So the port is settled first and threaded through as configuration, which is what it
 * is.
 *
 * An operator's own `publicUrl` SURVIVES the move — they were describing a proxy or a tunnel, not
 * this daemon's socket — while a derived one follows the port, because a derived advertisement that
 * stayed behind is precisely the defect this file exists to have removed.
 */
export function configuredAt(config: DaemonConfig, port: number): DaemonConfig {
  if (port === config.port) return { ...config, portIsRecorded: true };
  const bindUrl = daemonAddress(config.host, port);
  return {
    ...config,
    port,
    portIsRecorded: true,
    bindUrl,
    publicUrl: config.publicUrlIsRecorded ? config.publicUrl : bindUrl,
  };
}

/** Parses a complete configuration document and derives its canonical addresses. */
export function parseDaemonConfig(value: unknown): DaemonConfig {
  return DaemonConfigSchema.parse(value);
}

/**
 * The document a first boot writes into a fresh state home.
 *
 * The DOCUMENT rather than the parsed configuration, so no derived address is ever persisted. A
 * first boot that wrote `publicUrl` out would freeze it at the port it happened to default to, and
 * every later edit of `port` would move the bind while the advertisement stayed behind.
 */
export function defaultDaemonConfigDocument(): DaemonConfigDocument {
  return DaemonConfigDocumentSchema.parse({});
}

export function defaultDaemonConfig(): DaemonConfig {
  return parseDaemonConfig({});
}

/**
 * Whether this daemon is advertised at an address other than the one it binds.
 *
 * A LEGITIMATE deployment — a daemon behind a reverse proxy or a tunnel — so it is a fact to state,
 * never a refusal. It is worth stating because the historical cause was a defect rather than a
 * choice: homes written before derived values stopped being persisted still carry a `publicUrl`
 * frozen at whatever the port was on the day the home was created.
 */
export function advertisesForeignAddress(config: DaemonConfig): boolean {
  return new URL(config.publicUrl).origin !== new URL(config.bindUrl).origin;
}

/**
 * The configuration one run actually uses, once the command line has had its say.
 *
 * A PORT NAMED ON THE COMMAND LINE IS A CLAIM, exactly like a recorded one: somebody who pins an
 * address is telling you something, and they get that address or a clear failure — never a silent
 * fallback to somewhere else. It is not written down, because it was said about this run only.
 */
export function overriddenBy(config: DaemonConfig, overrides: RunOverrides): DaemonConfig {
  if (overrides.host === undefined && overrides.port === undefined) return config;
  const host = overrides.host ?? config.host;
  const port = overrides.port ?? config.port;
  const bindUrl = daemonAddress(host, port);
  return {
    ...config,
    host,
    port,
    portIsRecorded: overrides.port !== undefined || config.portIsRecorded,
    bindUrl,
    publicUrl: config.publicUrlIsRecorded ? config.publicUrl : bindUrl,
  };
}

/**
 * Reading and recording this daemon's configuration document.
 *
 * AN INTERFACE rather than the one adapter, because `--config` names a document outside the state
 * home and the state home's filesystem port refuses every path outside it — correctly, since that
 * confinement is what stops the daemon's own state escaping. An operator naming their own file is a
 * different act from the daemon addressing its own state, so it gets a different adapter and the
 * boot depends on neither.
 */
export interface DaemonConfigStore {
  /** The document an operator edits, so a refusal can name the file rather than describe it. */
  readonly path: string;
  /** What is on disk right now, parsed and raw, writing nothing. */
  peek(): Promise<{ readonly document: Record<string, unknown> | undefined; readonly config: DaemonConfig }>;
  /** The configuration to run on, seeding the document when the state home has none. */
  load(): Promise<DaemonConfig>;
  /** Writes down the address this daemon took, so it is the same one next time. */
  record(port: number): Promise<void>;
}
