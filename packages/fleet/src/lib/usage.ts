import { z } from 'zod';
import type { FleetManifest, FleetManifestAccount } from './manifest.ts';

const finiteNumber = z.number().refine(Number.isFinite, 'expected a finite number');
const percentage = finiteNumber.min(0).max(100);
const epochMilliseconds = finiteNumber.int().nonnegative();

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
}

export interface FleetUsageClock {
  now(): number;
}

export const systemFleetUsageClock: FleetUsageClock = { now: () => Date.now() };

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

  constructor(
    private readonly probe: FleetUsageProbe,
    private readonly clock: FleetUsageClock = systemFleetUsageClock,
    options: FleetUsageCollectorOptions = {},
  ) {
    this.concurrency = boundedConcurrency(options.concurrency);
    this.atLimitPercent = clampUsagePercent(options.atLimitPercent ?? 100) ?? 100;
  }

  async collect(manifest: FleetManifest): Promise<FleetUsageSnapshot> {
    const accounts = [...manifest.accounts].sort((left, right) => left.id.localeCompare(right.id));
    const rows = await boundedMap(accounts, this.concurrency, async account => await this.collectAccount(account));
    return FleetUsageSnapshotSchema.parse({ at: normalizeClock(this.clock.now()), accounts: rows });
  }

  private async collectAccount(account: FleetManifestAccount): Promise<FleetUsage> {
    const unavailableReason = declaredUnavailableReason(account);
    if (unavailableReason !== undefined) {
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

    try {
      const raw = FleetUsageProbeResultSchema.parse(await this.probe.probe(account));
      const shortWindow = normalizeWindow(raw.shortWindow);
      const longWindow = normalizeWindow(raw.longWindow);
      const unavailable = raw.unavailable === true;
      return FleetUsageSchema.parse({
        accountId: account.id,
        kind: account.kind,
        ...(raw.provider === undefined ? {} : { provider: raw.provider }),
        usageBased: raw.usageBased,
        ok: raw.ok,
        unavailable,
        ...(raw.unavailableReason === undefined ? {} : { unavailableReason: raw.unavailableReason }),
        ...(raw.authOk === undefined ? {} : { authOk: raw.authOk }),
        ...(raw.error === undefined ? {} : { error: raw.error }),
        ...(shortWindow === undefined ? {} : { shortWindow }),
        ...(longWindow === undefined ? {} : { longWindow }),
        // A failed transient probe must never block a consumer. Only a successful
        // quota reading or a probe-proven unavailable state may set this true.
        atLimit:
          unavailable || (raw.ok && (raw.atLimit === true || isAtLimit(shortWindow, longWindow, this.atLimitPercent))),
      });
    } catch (error) {
      return FleetUsageSchema.parse({
        accountId: account.id,
        kind: account.kind,
        usageBased: false,
        ok: false,
        unavailable: false,
        error: errorMessage(error),
        atLimit: false,
      });
    }
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

/** Render fleet usage as Prometheus text; unknown measurements intentionally have no series. */
export function renderFleetUsageMetrics(snapshot: FleetUsageSnapshot, now = Date.now()): string {
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
