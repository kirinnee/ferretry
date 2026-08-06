import {
  type Advertisement,
  type DaemonCapability,
  daemonAddress,
  decideAdvertisement,
  FY_DEFAULT_DAEMON_PORT,
  isWildcardHost,
  LOOPBACK,
} from '@ferretry/protocol';
import { SocketEndpointSchema } from '@ferretry/relay';
import { z } from 'zod';
import { normalizeAnalyticsModelIdentity } from '../analytics/model-identity.ts';
import type { AnalyticsPricingRate } from '../analytics/pricing.ts';
import { DEFAULT_CAPABILITY_GRANTS } from '../grants/policy.ts';
import type { RunOverrides } from './arguments.ts';
import {
  type DaemonCarrierSet,
  DaemonCarriersDocumentSchema,
  HostSchema,
  PortSchema,
  resolveDaemonCarriers,
} from './carriers.ts';

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
 * Where the daemon reads account health from, BESIDES this host's own fleet.
 *
 * The native collector is always first and needs nothing declared here. Both external sources are
 * optional and tried after it, in order. Neither is defaulted to a particular tool or address: the
 * source hardcoded one collector's name and flags into the daemon, so a host that ran anything else
 * had no fallback at all and no way to configure one.
 *
 * There is deliberately no refresh period in this block. How often quota is re-read is the fleet's
 * `usage.interval`, declared beside the thresholds and concurrency that shape the same collection —
 * a second name for it here is what let a daemon and its fleet disagree about one cadence.
 */
export const UsageFeedConfigSchema = z
  .object({
    /** An external collector's JSON usage endpoint. */
    url: z.url().optional(),
    /**
     * Fallback command for hosts that serve usage from another tool's CLI, as argv. The daemon
     * appends the flags it needs (see `USAGE_PROBE_FLAGS`); an empty list means there is no fallback.
     */
    fallbackCommand: z.array(z.string().trim().min(1)).readonly().default([]),
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
     *  only on localhost or 127.0.0.1, and no query or fragment. */
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
 * What the operator has agreed the UI may do on this machine, per capability and per axis.
 *
 * EVERY FIELD HAS A DEFAULT, so a document that says nothing is a complete decision rather than an
 * undetermined one — and the defaults are permissive, because the product's principle is that a
 * person controls as much as possible from the UI and the security layer is something a cautious
 * operator turns ON. See `DEFAULT_CAPABILITY_GRANTS` for why each answer is what it is.
 *
 * SILENCE AND DAMAGE ARE DIFFERENT THINGS, and this is where the difference is drawn. An omitted
 * capability means "the operator did not say", which this schema answers with the product default. A
 * capability spelled `{"use": "yes"}` means the document is WRONG, which `strictObject` and the
 * boolean turn into a parse failure — and a parse failure refuses the boot rather than falling back
 * to anything. Unknown is never permitted.
 */
const grantSchemaFor = (capability: DaemonCapability) =>
  z
    .strictObject({
      use: z.boolean().default(DEFAULT_CAPABILITY_GRANTS[capability].use),
      configure: z.boolean().default(DEFAULT_CAPABILITY_GRANTS[capability].configure),
    })
    .prefault({});

export const CapabilityGrantsDocumentSchema = z
  .strictObject({
    fleet: grantSchemaFor('fleet'),
    terminal: grantSchemaFor('terminal'),
    browser: grantSchemaFor('browser'),
    filesystem: grantSchemaFor('filesystem'),
    warden: grantSchemaFor('warden'),
    // Every capability in `DAEMON_CAPABILITIES` needs its key HERE, spelled out. The keys are literal
    // rather than derived from the array so the parsed type stays exact, and the cost of that is this
    // comment: a capability missing from this object is refused when an operator writes it AND absent
    // from what `readGrants` returns, while `CapabilityGrants` says it is there. TypeScript does not
    // catch the second — a strict object widens on the way out.
    pairing: grantSchemaFor('pairing'),
  })
  .prefault({});

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
    host: HostSchema.default(LOOPBACK),
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
     * EVERY WAY THIS DAEMON MAY BE REACHED, as one list, beside the legacy spelling of the same fact.
     *
     * `host`, `port` and `relay` above remain readable as a one-bind, one-relay list, and a kind this
     * array names WINS over its legacy spelling — per kind, so a half-finished migration keeps
     * listening where it always did. Nothing here is derived and nothing derived is written back:
     * see `runtime/carriers.ts`, which owns the shape, the bounds and the precedence rule.
     */
    carriers: DaemonCarriersDocumentSchema,
    /**
     * Prices the operator has personally supplied for this daemon's usage.
     * These are API-equivalent rates, not a statement of subscription spend.
     */
    analyticsPricing: AnalyticsPricingCatalogSchema.default([]),
    projectRoots: z.array(z.string().trim().min(1)).readonly().default(['~/Workspace', '~/.config']),
    /**
     * Reusable environment recipes for the use-without-read primitive, holding REFERENCES only.
     *
     * A value here is a spelling an operator writes once — `AUTH_HEADER: "Bearer ${secret:TOKEN}"` —
     * instead of every caller re-deriving it. THE VALUE OF THE SECRET IS NEVER HERE: this file is
     * copied into backups, dotfile repositories and screen shares, which is precisely why the store
     * exists, so the document carries the name and the daemon resolves it when it spawns a child.
     *
     * A recipe is injected ONLY when every secret it names is one the caller explicitly asked for.
     * Without that rule an operator's convenience would silently widen a request: a child that asked
     * for a staging key would be handed a header built from the production one.
     */
    secretEnvironment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u), z.string()).default({}),
    /**
     * What this machine has agreed a caller who is NOT on this host may do.
     *
     * IT BELONGS IN THIS DOCUMENT rather than in a file of its own, so `--print-config` reports it
     * beside `port` and `corsOrigins` with the same provenance treatment: a person asking why the UI
     * refused something should read the answer where they already read every other effective value,
     * and should be told whether they chose it or the product did. What does NOT live here is the
     * password VERIFIER that gates changing these — this file travels into backups and screen shares,
     * which is exactly the journey a verifier must not make.
     */
    grants: CapabilityGrantsDocumentSchema,
  })
  .strict();

export type DaemonConfigDocument = z.output<typeof DaemonConfigDocumentSchema>;

/**
 * Every address one host-and-port pair implies, derived in the ONE place all three paths read.
 *
 * THREE PATHS REACH IT — the load below, a port moved at boot, and a `--host`/`--port` override — and
 * each used to compose the advertisement itself. Three copies of one derivation is three chances for
 * them to disagree, and the disagreement is silent: a daemon that advertises what it does not bind,
 * or binds what it does not advertise, serves perfectly and hands out a dead address.
 *
 * `WHO CAN REACH IT` IS DECIDED HERE TOO, by the protocol, and is not the same fact as `publicUrl`.
 * The `??` this replaced welded two facts into one field — where I listen, and where I can be reached
 * — so a default loopback install advertised the loopback address and pairing put it into a QR that,
 * on the phone reading it, named the phone.
 */
function derivedAddresses(input: {
  readonly host: string;
  readonly port: number;
  readonly operatorPublicUrl?: string;
}): {
  readonly bindUrl: string;
  readonly advertisement: Advertisement;
  readonly publicUrl: string;
  readonly publicUrlIsRecorded: boolean;
} {
  const bindUrl = daemonAddress(input.host, input.port);
  const advertisement = decideAdvertisement(input);
  return {
    bindUrl,
    advertisement,
    // The bind is still the ANSWER OF LAST RESORT for the surfaces that need a string no matter what —
    // a browser origin, a CORS entry, an incumbent probe. What changed is that nothing derives an
    // AUDIENCE from it: pairing reads `advertisement`, which says outright when there is nobody to
    // hand this to, rather than handing out a bind instruction and hoping.
    publicUrl: advertisement.kind === 'none' ? bindUrl : advertisement.url,
    publicUrlIsRecorded: input.operatorPublicUrl !== undefined,
  };
}

/**
 * The resolved carrier set with the bind this boot is ACTUALLY on.
 *
 * A declared bind may name no port at all, and a settled port or a `--port` may move the one it does
 * name — so the set every later stage reads carries the effective address rather than the written
 * one. It is derived on every read, exactly like `bindUrl`, and for the same reason: a carrier set
 * that stayed behind while the socket moved would put the two facts back into the disagreement this
 * whole shape exists to make unrepresentable. Nothing here is ever written back to the document.
 */
function boundAt(carriers: DaemonCarrierSet, bind: { readonly host: string; readonly port: number }): DaemonCarrierSet {
  return { bind: { kind: 'bind', host: bind.host, port: bind.port }, relays: carriers.relays };
}

/** The recorded advertisement as `decideAdvertisement` wants it: absent rather than empty. */
function operatorPublicUrl(publicUrl: string | undefined): { readonly operatorPublicUrl?: string } {
  return publicUrl === undefined ? {} : { operatorPublicUrl: publicUrl };
}

/**
 * The operator's own advertisement, carried through a re-derivation, or nothing when it was derived.
 *
 * A RECORDED `publicUrl` SURVIVES A MOVED PORT — an operator describing a proxy or a tunnel was not
 * describing this daemon's socket — while a derived one follows the port, because a derived
 * advertisement that stayed behind is precisely the defect this file exists to have removed. The
 * derived `publicUrl` is dropped rather than fed back in, so a re-derivation reads the DOCUMENT's
 * answer and never the last computation's.
 */
function recordedAdvertisement(config: DaemonConfig): { readonly operatorPublicUrl?: string } {
  return operatorPublicUrl(config.publicUrlIsRecorded ? config.publicUrl : undefined);
}

/**
 * The document plus everything derived from it: the port to try, the two addresses, who can reach the
 * advertised one, and which of them the document actually recorded.
 *
 * `bindUrl` is what this daemon LISTENS on and is therefore what an incumbent probe must ask: a
 * responder is only this boot's problem when it holds the very socket the bind wants. Probing the
 * advertised URL instead is how a stale advertisement sent a boot to interrogate an unrelated
 * program on a port it was not even going to bind.
 *
 * `publicUrl` is what this daemon is REACHED at, which is the same address unless an operator said
 * otherwise, and it is what browser origins carry.
 *
 * `advertisement` is that address WITH ITS AUDIENCE, and it is what pairing reads. It is a separate
 * field because "an address" and "an address somebody else can dial" are separate facts, and one
 * field answering both is the defect this file was rewritten to remove.
 *
 * The two `…IsRecorded` flags exist because a value's ORIGIN changes what may be done with it, and
 * once derivation happens on every read there is otherwise no way to tell a default from a choice.
 * A recorded port is claimed; an unrecorded one is a preference this boot may move off. A recorded
 * public URL survives a moved port; an unrecorded one follows it.
 *
 * `carrierSet` is every way this daemon may be reached, resolved ONCE. Host and port are read off its
 * bind rather than off the document, which is what makes an explicit bind carrier a decision rather
 * than a decoration: the two spellings would otherwise agree everywhere except at the socket.
 */
export const DaemonConfigSchema = DaemonConfigDocumentSchema.transform(value => {
  const declared = resolveDaemonCarriers({
    host: value.host,
    port: value.port,
    relay: value.relay,
    carriers: value.carriers,
  });
  const host = declared.bind.host;
  const port = declared.bind.port ?? FY_DEFAULT_DAEMON_PORT;
  return {
    ...value,
    host,
    port,
    // Read off the resolved bind, not off `value.port`: a `port` key superseded by a portless bind
    // carrier is not a claim on anything, and treating it as one would refuse a boot over a line the
    // operator has already migrated away from.
    portIsRecorded: declared.bind.port !== undefined,
    carrierSet: boundAt(declared, { host, port }),
    ...derivedAddresses({ host, port, ...operatorPublicUrl(value.publicUrl) }),
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
 * What survives the move and what follows it is `recordedAdvertisement`'s decision, made once for
 * this path and the override path alike.
 */
export function configuredAt(config: DaemonConfig, port: number): DaemonConfig {
  if (port === config.port) return { ...config, portIsRecorded: true };
  return {
    ...config,
    port,
    portIsRecorded: true,
    carrierSet: boundAt(config.carrierSet, { host: config.host, port }),
    ...derivedAddresses({ host: config.host, port, ...recordedAdvertisement(config) }),
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
 * The document to write when a boot has settled on a port, with that port in the key that DECIDES it.
 *
 * ONE HELPER FOR BOTH ADAPTERS, because the state home's document and the one an operator names with
 * `--config` must answer this identically — a port that landed in a different key depending on which
 * file it was is a difference nobody could see and everybody would hit.
 *
 * WHERE THE PORT GOES FOLLOWS WHERE IT IS READ FROM. A document with an explicit bind carrier reads
 * its address from that entry, so writing the top-level `port` there would write a key with no effect
 * on where this daemon listens: the operator watches the number change, watches the daemon come up
 * somewhere else, and has nothing to go on. Without a bind carrier the legacy key IS the bind, so it
 * is where the port belongs and it keeps getting written.
 *
 * THE SUPERSEDED KEY IS LEFT EXACTLY AS TYPED, never rewritten and never deleted. It is the
 * operator's line to finish migrating, and `supersededCarrierKeys` is what tells them it is there.
 */
export function recordedPortDocument(document: DaemonConfigDocument, port: number): DaemonConfigDocument {
  if (!document.carriers.some(carrier => carrier.kind === 'bind')) return { ...document, port };
  return {
    ...document,
    carriers: document.carriers.map(carrier => (carrier.kind === 'bind' ? { ...carrier, port } : carrier)),
  };
}

/**
 * Whether this daemon is advertised at an address other than the one it binds.
 *
 * A LEGITIMATE deployment — a daemon behind a reverse proxy or a tunnel — so it is a fact to state,
 * never a refusal. It is worth stating because the historical cause was a defect rather than a
 * choice: homes written before derived values stopped being persisted still carry a `publicUrl`
 * frozen at whatever the port was on the day the home was created.
 *
 * A WILDCARD BIND IS NEVER FOREIGN, AND SAYING SO IS THE POINT. A daemon told to accept every
 * interface has no single address to compare against, and pairing's own remedy now asks for exactly
 * this pair — bind everywhere, advertise the one address a device can dial. Comparing a wildcard
 * bind instruction with that advertisement finds them different every time and prints "if that is
 * not deliberate, remove publicUrl" at the operator who just deliberately added it. A notice that
 * tells somebody to undo the documented fix is worse than no notice.
 */
export function advertisesForeignAddress(config: DaemonConfig): boolean {
  if (isWildcardHost(config.host)) return false;
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
  return {
    ...config,
    host,
    port,
    portIsRecorded: overrides.port !== undefined || config.portIsRecorded,
    carrierSet: boundAt(config.carrierSet, { host, port }),
    ...derivedAddresses({ host, port, ...recordedAdvertisement(config) }),
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
