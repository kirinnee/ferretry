import { z } from 'zod';
import type { FleetConfig } from './config.ts';
import { accountIdentityKeys } from './identity.ts';
import type { FleetManifest, FleetManifestAccount } from './manifest.ts';

const finiteNumber = z.number().refine(Number.isFinite, 'expected a finite number');
const percentage = finiteNumber.min(0).max(100);
const epochMilliseconds = finiteNumber.int().nonnegative();

/**
 * WHAT THE FREE PROVIDER READ SAID ABOUT THE CREDENTIAL, as a closed classification.
 *
 * This exists because `authOk` cannot carry it. `authOk` answers one question — is this credential
 * repudiated — and it collapses three answers that mean different things into `true`: a `200` that
 * accepted the token, a `403` that accepted it and refused to show usage, and a `503` that said
 * nothing at all. Quota does not care which of those happened; a health verdict is nothing but that
 * distinction, and a build that turned the third into `healthy` would report a working account for
 * every provider outage.
 *
 * IT IS A CLASSIFICATION, NEVER MATERIAL. Every member is a fixed word chosen from an HTTP status,
 * so a row carrying one cannot carry a token, a header or a provider body. The reason the status is
 * mapped at the adapter rather than travelling as a number is that a consumer holding a number
 * writes its own table, and two tables are how `403` becomes a re-login for somebody.
 */
export const FleetCredentialSignalSchema = z.enum([
  /** The provider answered for this token: it is currently accepted. */
  'accepted',
  /**
   * Anthropic-shaped JSON `403` from the read-only usage endpoint. The token is ACCEPTED and merely
   * lacks `user:profile`, which is permanent for an inference-scoped token. An HTML/WAF `403` is
   * inconclusive instead; the response fingerprint is what keeps those equal statuses apart.
   */
  'scope_unavailable',
  /** An explicit credential rejection. A bare control-plane `401` is not enough to produce this. */
  'rejected',
  /** `401` whose response cannot distinguish credential rejection from refusal of this HTTP client. */
  'rejection_unconfirmed',
  /** The request did not finish inside its deadline. Inconclusive, never a rejection. */
  'timeout',
  /** Reached, and said nothing usable: a 5xx, a 429, another 4xx, a transport failure. */
  'inconclusive',
  /** There was no readable token to ask with, so no request was made. */
  'absent',
]);

export type FleetCredentialSignal = z.infer<typeof FleetCredentialSignalSchema>;

/** JSON value kinds retained in a response fingerprint. Values themselves never travel. */
export const ProviderResponseJsonTypeSchema = z.enum(['null', 'boolean', 'number', 'string', 'array', 'object']);
export type ProviderResponseJsonType = z.infer<typeof ProviderResponseJsonTypeSchema>;

const diagnosticText = z.string().min(1).max(256);
const responseHeaderName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9a-z]+$/u, 'expected a normalized HTTP header name');

/** A header's authentication challenge, reduced to non-secret protocol words. */
export const ProviderAuthenticationShapeSchema = z.strictObject({
  scheme: diagnosticText,
  errorCode: diagnosticText.optional(),
});
export type ProviderAuthenticationShape = z.infer<typeof ProviderAuthenticationShapeSchema>;

/** The only response header VALUES permitted to survive. Every other header contributes its name only. */
export const ProviderResponseHeaderValuesSchema = z.strictObject({
  anthropicRequestId: diagnosticText.optional(),
  cfMitigated: diagnosticText.optional(),
  cfRay: diagnosticText.optional(),
  requestId: diagnosticText.optional(),
  retryAfter: diagnosticText.optional(),
  retryAfterMs: diagnosticText.optional(),
  server: diagnosticText.optional(),
  wwwAuthenticate: ProviderAuthenticationShapeSchema.optional(),
  xRequestId: diagnosticText.optional(),
});
export type ProviderResponseHeaderValues = z.infer<typeof ProviderResponseHeaderValuesSchema>;

/** One key path and only the kind of value behind it — never the value. */
export const ProviderResponseJsonFieldSchema = z.strictObject({
  path: diagnosticText,
  type: ProviderResponseJsonTypeSchema,
});
export type ProviderResponseJsonField = z.infer<typeof ProviderResponseJsonFieldSchema>;

/** A bounded JSON outline plus the provider's code-like error labels, when present. */
export const ProviderResponseJsonShapeSchema = z.strictObject({
  type: ProviderResponseJsonTypeSchema,
  fields: z.array(ProviderResponseJsonFieldSchema).max(64),
  fieldsTruncated: z.literal(true).optional(),
  envelopeType: diagnosticText.optional(),
  errorType: diagnosticText.optional(),
  errorCode: diagnosticText.optional(),
});
export type ProviderResponseJsonShape = z.infer<typeof ProviderResponseJsonShapeSchema>;

/**
 * A secret-safe description of one provider response.
 *
 * The body contributes only its byte length, SHA-256 digest, key/type outline and code-like error
 * labels. A normal response is described in full; `bodyTruncated` says an oversized response was
 * cancelled and the length/digest cover only the hard-capped prefix. Header NAMES are safe to
 * enumerate; values survive only through the closed allowlist above. There is deliberately no
 * free-form string or provider body field for a token to travel in.
 */
export const ProviderResponseFingerprintSchema = z.strictObject({
  status: z.number().int().min(100).max(599),
  contentType: diagnosticText.optional(),
  headerNames: z.array(responseHeaderName).max(128),
  headerNamesTruncated: z.literal(true).optional(),
  headers: ProviderResponseHeaderValuesSchema.optional(),
  bodyLength: z.number().int().nonnegative().refine(Number.isFinite, 'expected a finite body length'),
  bodySha256: z.string().regex(/^[0-9a-f]{64}$/u, 'expected a SHA-256 digest'),
  bodyTruncated: z.literal(true).optional(),
  json: ProviderResponseJsonShapeSchema.optional(),
});
export type ProviderResponseFingerprint = z.infer<typeof ProviderResponseFingerprintSchema>;

/** A normalized quota window. Percentages always mean consumed capacity. */
export const FleetUsageWindowSchema = z.strictObject({
  usedPercent: percentage.optional(),
  resetAt: epochMilliseconds.optional(),
});

export type FleetUsageWindow = z.infer<typeof FleetUsageWindowSchema>;

/** The complete, account-scoped result returned by a usage adapter. */
export const FleetUsageProbeResultSchema = z.strictObject({
  provider: z.string().min(1).optional(),
  usageBased: z.boolean(),
  ok: z.boolean(),
  unavailable: z.boolean().optional(),
  unavailableReason: z.string().min(1).optional(),
  authOk: z.boolean().optional(),
  /**
   * What the free provider read established about the credential, when a probe was in a position to
   * establish anything. Absent means this probe does not speak for this account at all — which is
   * how a Codex account reaches a health verdict of "unproven" rather than one invented from a
   * probe that declined to run.
   */
  credentialSignal: FleetCredentialSignalSchema.optional(),
  /** Secret-safe evidence from the HTTP response that produced `credentialSignal`. */
  responseFingerprint: ProviderResponseFingerprintSchema.optional(),
  error: z.string().min(1).optional(),
  shortWindow: FleetUsageWindowSchema.optional(),
  longWindow: FleetUsageWindowSchema.optional(),
  atLimit: z.boolean().optional(),
});

export type FleetUsageProbeResult = z.infer<typeof FleetUsageProbeResultSchema>;

/**
 * The only boundary required by the collector. Adapters may read credentials or
 * call providers; this library module deliberately does neither.
 */
export interface FleetUsageProbe {
  probe(account: FleetManifestAccount): Promise<FleetUsageProbeResult>;
}

/** One usage row, keyed solely by the stable manifest account ID. */
export const FleetUsageSchema = z.strictObject({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  provider: z.string().min(1).optional(),
  usageBased: z.boolean(),
  ok: z.boolean(),
  unavailable: z.boolean(),
  unavailableReason: z.string().min(1).optional(),
  authOk: z.boolean().optional(),
  /**
   * Carried through per credential GROUP, exactly like the quota reading beside it, because it was
   * measured against the group's shared login. A sibling's own LOCAL credential copy is read
   * separately by the health collector, and a positively dead local copy outranks this — see
   * `./health.ts`, which is where the two are joined.
   */
  credentialSignal: FleetCredentialSignalSchema.optional(),
  /** The representative request's secret-safe response evidence, shared with this credential group. */
  responseFingerprint: ProviderResponseFingerprintSchema.optional(),
  error: z.string().min(1).optional(),
  shortWindow: FleetUsageWindowSchema.optional(),
  longWindow: FleetUsageWindowSchema.optional(),
  atLimit: z.boolean(),
});

export type FleetUsage = z.infer<typeof FleetUsageSchema>;

/** The cached wire contract served by the fleet endpoint. */
export const FleetUsageSnapshotSchema = z.strictObject({
  at: epochMilliseconds,
  accounts: z.array(FleetUsageSchema),
});

export type FleetUsageSnapshot = z.infer<typeof FleetUsageSnapshotSchema>;

export interface FleetUsageCollectorOptions {
  readonly concurrency?: number;
  readonly atLimitPercent?: number;
  /**
   * Which provider login an account shares, so accounts on one credential are probed **once**.
   *
   * Supplied by the caller because it is read from the declared configuration, not from the manifest —
   * and deliberately not derived by comparing credentials, which would mean handling secrets to decide
   * a grouping the author already wrote down. Omitted means one probe per account, which is only right
   * when nothing is shared.
   */
  readonly identityOf?: (account: FleetManifestAccount) => string;
}

export interface FleetUsageClock {
  now(): number;
}

/** Clamp a provider percentage into the public 0–100 usage range. */
export function clampUsagePercent(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, value));
}

/** Convert a provider's remaining-capacity percentage into consumed capacity. */
export function usedPercentFromRemaining(value: unknown): number | undefined {
  const remaining = clampUsagePercent(value);
  return remaining === undefined ? undefined : 100 - remaining;
}

/** Normalize ISO timestamps, epoch seconds, and epoch milliseconds to milliseconds. */
export function normalizeResetAt(value: unknown): number | undefined {
  let milliseconds: number | undefined;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) milliseconds = parsed;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    // Epoch seconds are currently ten digits; epoch milliseconds are thirteen.
    milliseconds = Math.abs(value) < 100_000_000_000 ? value * 1000 : value;
  }
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.trunc(milliseconds);
}

export interface FleetUsageWindowInput {
  readonly usedPercent?: unknown;
  readonly remainingPercent?: unknown;
  readonly resetAt?: unknown;
}

/**
 * Providers that do not name their quota windows are normalized by reset horizon:
 * the earliest reset is short and the latest is long. Equal or missing resets keep
 * their input order, making the result deterministic.
 */
export function normalizeUsageWindows(windows: readonly FleetUsageWindowInput[]): {
  readonly shortWindow?: FleetUsageWindow;
  readonly longWindow?: FleetUsageWindow;
} {
  const normalized = windows.map((window, index) => {
    const direct = clampUsagePercent(window.usedPercent);
    const usedPercent = direct ?? usedPercentFromRemaining(window.remainingPercent);
    const resetAt = normalizeResetAt(window.resetAt);
    return {
      index,
      window: {
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetAt === undefined ? {} : { resetAt }),
      } satisfies FleetUsageWindow,
      order: resetAt ?? Number.POSITIVE_INFINITY,
    };
  });
  if (normalized.length === 0) return {};
  normalized.sort((left, right) => left.order - right.order || left.index - right.index);
  const shortWindow = normalized[0]?.window;
  const longWindow = normalized[normalized.length - 1]?.window;
  return {
    ...(shortWindow === undefined ? {} : { shortWindow }),
    ...(longWindow === undefined ? {} : { longWindow }),
  };
}

/** A quota is exhausted when either known window reaches the configured threshold. */
export function isAtLimit(
  shortWindow: FleetUsageWindow | undefined,
  longWindow: FleetUsageWindow | undefined,
  threshold = 100,
): boolean {
  const limit = clampUsagePercent(threshold) ?? 100;
  return (shortWindow?.usedPercent ?? -Infinity) >= limit || (longWindow?.usedPercent ?? -Infinity) >= limit;
}

/**
 * A hard authentication verdict is only accepted when every collected attempt
 * agrees. Transport errors and successful attempts make the result inconclusive.
 */
export function isCorroboratedAuthRejection(verdicts: readonly (boolean | undefined)[], attempts = 3): boolean {
  const required = Math.max(1, Math.trunc(attempts));
  return verdicts.length >= required && verdicts.every(verdict => verdict === false);
}

/** Collects manifest accounts without reading wrappers, the shell, or the filesystem. */
export class FleetUsageCollector {
  private readonly concurrency: number;
  private readonly atLimitPercent: number;
  private readonly identityOf: (account: FleetManifestAccount) => string;

  constructor(
    private readonly probe: FleetUsageProbe,
    private readonly clock: FleetUsageClock,
    options: FleetUsageCollectorOptions = {},
  ) {
    this.concurrency = boundedConcurrency(options.concurrency);
    this.atLimitPercent = clampUsagePercent(options.atLimitPercent ?? 100) ?? 100;
    // Without a grouping, every account is its own group — the previous behaviour exactly.
    this.identityOf = options.identityOf ?? (account => account.id);
  }

  /**
   * One row per account, probing once per **credential** rather than once per account.
   *
   * Accounts that share a provider login share a quota, so asking about each of them separately asks
   * the same question N times: thirty wrappers on six provider accounts made thirty provider calls,
   * and on a rate-limited account those extra calls are the worst possible thing to spend. Each group
   * is probed once through its lowest-id member and the reading is copied to its siblings.
   *
   * Grouping comes from the caller's `identityOf`, which reads the **declared** identity — no
   * credential is hashed or compared to work out which accounts are the same account.
   *
   * An account the manifest declares unavailable is never probed and never a group's representative:
   * it gets its own row from the declaration, so an unavailable lane cannot suppress its siblings.
   */
  async collect(manifest: FleetManifest): Promise<FleetUsageSnapshot> {
    const accounts = [...manifest.accounts].sort((left, right) => left.id.localeCompare(right.id));

    const declared = new Map<string, string>();
    const groups = new Map<string, FleetManifestAccount[]>();
    for (const account of accounts) {
      const unavailableReason = declaredUnavailableReason(account);
      if (unavailableReason !== undefined) {
        declared.set(account.id, unavailableReason);
        continue;
      }
      const key = this.identityOf(account);
      const existing = groups.get(key);
      if (existing === undefined) groups.set(key, [account]);
      else existing.push(account);
    }

    const keys = [...groups.keys()];
    const probed = await boundedMap(keys, this.concurrency, async key => await this.#probe(groups.get(key) ?? []));
    const readings = new Map(keys.map((key, index) => [key, probed[index]]));

    const rows = accounts.map(account => {
      const unavailableReason = declared.get(account.id);
      if (unavailableReason !== undefined) return this.#unavailableRow(account, unavailableReason);
      const reading = readings.get(this.identityOf(account));
      return reading === undefined ? this.#failedRow(account, 'usage probe failed') : this.#row(account, reading);
    });

    return FleetUsageSnapshotSchema.parse({ at: normalizeClock(this.clock.now()), accounts: rows });
  }

  /** Probe one group through its representative. A throw becomes a failure, never a reading. */
  async #probe(group: readonly FleetManifestAccount[]): Promise<FleetUsageProbeResult | string> {
    const representative = group[0];
    if (representative === undefined) return 'no account to probe';
    try {
      return FleetUsageProbeResultSchema.parse(await this.probe.probe(representative));
    } catch (error) {
      return errorMessage(error);
    }
  }

  #unavailableRow(account: FleetManifestAccount, unavailableReason: string): FleetUsage {
    return FleetUsageSchema.parse({
      accountId: account.id,
      kind: account.kind,
      usageBased: false,
      ok: false,
      unavailable: true,
      unavailableReason,
      atLimit: false,
    });
  }

  #failedRow(account: FleetManifestAccount, error: string): FleetUsage {
    return FleetUsageSchema.parse({
      accountId: account.id,
      kind: account.kind,
      usageBased: false,
      ok: false,
      unavailable: false,
      error,
      atLimit: false,
    });
  }

  /** Build one account's row from its group's reading. A reason string means the probe failed. */
  #row(account: FleetManifestAccount, reading: FleetUsageProbeResult | string): FleetUsage {
    if (typeof reading === 'string') return this.#failedRow(account, reading);
    const shortWindow = normalizeWindow(reading.shortWindow);
    const longWindow = normalizeWindow(reading.longWindow);
    const unavailable = reading.unavailable === true;
    return FleetUsageSchema.parse({
      accountId: account.id,
      kind: account.kind,
      ...(reading.provider === undefined ? {} : { provider: reading.provider }),
      usageBased: reading.usageBased,
      ok: reading.ok,
      unavailable,
      ...(reading.unavailableReason === undefined ? {} : { unavailableReason: reading.unavailableReason }),
      ...(reading.authOk === undefined ? {} : { authOk: reading.authOk }),
      ...(reading.credentialSignal === undefined ? {} : { credentialSignal: reading.credentialSignal }),
      ...(reading.responseFingerprint === undefined ? {} : { responseFingerprint: reading.responseFingerprint }),
      ...(reading.error === undefined ? {} : { error: reading.error }),
      ...(shortWindow === undefined ? {} : { shortWindow }),
      ...(longWindow === undefined ? {} : { longWindow }),
      // A failed transient probe must never block a consumer. Only a successful
      // quota reading or a probe-proven unavailable state may set this true.
      atLimit:
        unavailable ||
        (reading.ok && (reading.atLimit === true || isAtLimit(shortWindow, longWindow, this.atLimitPercent))),
    });
  }
}

/** Render the exact JSON endpoint envelope, without incidental whitespace. */
export function renderFleetUsageJson(snapshot: FleetUsageSnapshot): string {
  return JSON.stringify(FleetUsageSnapshotSchema.parse(snapshot));
}

/** Escape Prometheus label values according to the text exposition format. */
export function escapePrometheusLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

/**
 * Render fleet usage as Prometheus text; unknown measurements intentionally have no series.
 * `now` is supplied by the caller — the age gauge is the only clock-dependent value here, and a
 * default would make this function untestable without freezing time.
 */
export function renderFleetUsageMetrics(snapshot: FleetUsageSnapshot, now: number): string {
  const checked = FleetUsageSnapshotSchema.parse(snapshot);
  const lines = [
    '# HELP fy_fleet_usage_probe_age_seconds Seconds since the last fleet usage snapshot (-1 = never).',
    '# TYPE fy_fleet_usage_probe_age_seconds gauge',
    `fy_fleet_usage_probe_age_seconds ${checked.at === 0 ? -1 : Math.max(0, Math.round((now - checked.at) / 1000))}`,
    '# HELP fy_fleet_account_usage_based Whether this account has numerical usage windows (1=yes).',
    '# TYPE fy_fleet_account_usage_based gauge',
    '# HELP fy_fleet_account_usage_ok Whether the last usage probe succeeded (1=yes).',
    '# TYPE fy_fleet_account_usage_ok gauge',
    '# HELP fy_fleet_account_unavailable Whether this account is proven unavailable (1=yes).',
    '# TYPE fy_fleet_account_unavailable gauge',
    '# HELP fy_fleet_account_auth_ok Whether credentials are known valid (1=yes, 0=no).',
    '# TYPE fy_fleet_account_auth_ok gauge',
    '# HELP fy_fleet_account_at_limit Whether either quota window is exhausted (1=yes).',
    '# TYPE fy_fleet_account_at_limit gauge',
    '# HELP fy_fleet_account_usage_5h_percent Consumed capacity in the short quota window.',
    '# TYPE fy_fleet_account_usage_5h_percent gauge',
    '# HELP fy_fleet_account_usage_weekly_percent Consumed capacity in the long quota window.',
    '# TYPE fy_fleet_account_usage_weekly_percent gauge',
    '# HELP fy_fleet_account_usage_5h_reset_seconds Unix time the short quota window resets.',
    '# TYPE fy_fleet_account_usage_5h_reset_seconds gauge',
    '# HELP fy_fleet_account_usage_weekly_reset_seconds Unix time the long quota window resets.',
    '# TYPE fy_fleet_account_usage_weekly_reset_seconds gauge',
  ];

  for (const account of checked.accounts) {
    const labels = prometheusLabels(account);
    lines.push(`fy_fleet_account_usage_based{${labels}} ${account.usageBased ? 1 : 0}`);
    lines.push(`fy_fleet_account_usage_ok{${labels}} ${account.ok ? 1 : 0}`);
    lines.push(`fy_fleet_account_unavailable{${labels}} ${account.unavailable ? 1 : 0}`);
    lines.push(`fy_fleet_account_at_limit{${labels}} ${account.atLimit ? 1 : 0}`);
    if (account.authOk !== undefined) lines.push(`fy_fleet_account_auth_ok{${labels}} ${account.authOk ? 1 : 0}`);
    if (account.shortWindow?.usedPercent !== undefined)
      lines.push(`fy_fleet_account_usage_5h_percent{${labels}} ${account.shortWindow.usedPercent}`);
    if (account.longWindow?.usedPercent !== undefined)
      lines.push(`fy_fleet_account_usage_weekly_percent{${labels}} ${account.longWindow.usedPercent}`);
    if (account.shortWindow?.resetAt !== undefined)
      lines.push(
        `fy_fleet_account_usage_5h_reset_seconds{${labels}} ${Math.floor(account.shortWindow.resetAt / 1000)}`,
      );
    if (account.longWindow?.resetAt !== undefined)
      lines.push(
        `fy_fleet_account_usage_weekly_reset_seconds{${labels}} ${Math.floor(account.longWindow.resetAt / 1000)}`,
      );
  }
  return `${lines.join('\n')}\n`;
}

function normalizeWindow(window: FleetUsageWindow | undefined): FleetUsageWindow | undefined {
  if (window === undefined) return undefined;
  const usedPercent = clampUsagePercent(window.usedPercent);
  const resetAt = normalizeResetAt(window.resetAt);
  return usedPercent === undefined && resetAt === undefined
    ? undefined
    : {
        ...(usedPercent === undefined ? {} : { usedPercent }),
        ...(resetAt === undefined ? {} : { resetAt }),
      };
}

function declaredUnavailableReason(account: FleetManifestAccount): string | undefined {
  if (!account.available) return account.unavailableReason ?? 'account unavailable';
  // A manifest may retain disabled models for auditability. They do not make an
  // account unavailable while at least one model remains selectable.
  const models = account.models as readonly { readonly available?: boolean; readonly unavailableReason?: string }[];
  if (models.length > 0 && models.every(model => model.available === false))
    return models.find(model => model.unavailableReason !== undefined)?.unavailableReason ?? 'no available models';
  return undefined;
}

function normalizeClock(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function boundedConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 6;
  return Math.max(1, Math.trunc(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'usage probe failed';
}

function prometheusLabels(account: FleetUsage): string {
  const labels = [
    `account_id="${escapePrometheusLabel(account.accountId)}"`,
    `kind="${escapePrometheusLabel(account.kind)}"`,
  ];
  if (account.provider !== undefined) labels.push(`provider="${escapePrometheusLabel(account.provider)}"`);
  return labels.join(',');
}

async function boundedMap<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  map: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) return;
      output[index] = await map(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return output;
}

/**
 * The one way to build a usage collector.
 *
 * Both `fy fleet usage` and the daemon's `GET /v1/fleet/usage` answer the same question about the same
 * host, so they must answer it the same way. Two call sites each assembling their own collector is how
 * they drift: one honours a declared `atLimitPercent` and the other does not, or one probes per
 * credential and the other per account, and eventually they disagree about whether an account has
 * quota left. Everything that shapes the answer — the thresholds, the concurrency and the grouping —
 * is read from the configuration here, once.
 *
 * Built per invocation rather than once at startup because all three are configuration, and a collector
 * assembled before the configuration was read can only ever use the defaults.
 */
export function buildFleetUsageCollector(
  config: FleetConfig,
  probe: FleetUsageProbe,
  clock: FleetUsageClock,
): FleetUsageCollector {
  return new FleetUsageCollector(probe, clock, {
    concurrency: config.usage.concurrency,
    atLimitPercent: config.usage.atLimitPercent,
    identityOf: accountIdentityKeys(config),
  });
}
