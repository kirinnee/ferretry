import { z } from 'zod';
import type { FleetConfig } from './config.ts';
import type { FleetManifest, FleetManifestAccount } from './manifest.ts';

const epochMilliseconds = z.number().int().nonnegative().refine(Number.isFinite, 'expected a finite number');

/** Why a wrapper that was actually started could not prove it can complete a turn. */
export const FleetHealthFailureKindSchema = z.enum([
  'rate_limited',
  'authentication',
  'timeout',
  'launch',
  'process_error',
  'unexpected_reply',
]);
export type FleetHealthFailureKind = z.infer<typeof FleetHealthFailureKindSchema>;

/** `unknown` is deliberately not a softer spelling of down: no probe verdict exists. */
export const FleetHealthStateSchema = z.enum(['healthy', 'down', 'unknown']);
export type FleetHealthState = z.infer<typeof FleetHealthStateSchema>;

export const FleetHealthProbeResultSchema = z.strictObject({
  state: FleetHealthStateSchema,
  cached: z.boolean(),
  checkedAt: epochMilliseconds,
  ms: epochMilliseconds,
  failureKind: FleetHealthFailureKindSchema.optional(),
  error: z.string().min(1).optional(),
});
export type FleetHealthProbeResult = z.infer<typeof FleetHealthProbeResultSchema>;

/** The sole impure boundary: the collector neither launches wrappers nor reads cache files. */
export interface FleetHealthProbe {
  probe(account: FleetManifestAccount): Promise<FleetHealthProbeResult>;
}

export const FleetHealthSchema = z.strictObject({
  accountId: z.string().min(1),
  kind: z.string().min(1),
  state: FleetHealthStateSchema,
  cached: z.boolean(),
  checkedAt: epochMilliseconds,
  ms: epochMilliseconds,
  failureKind: FleetHealthFailureKindSchema.optional(),
  error: z.string().min(1).optional(),
});
export type FleetHealth = z.infer<typeof FleetHealthSchema>;

export const FleetHealthSnapshotSchema = z.strictObject({
  at: epochMilliseconds,
  accounts: z.array(FleetHealthSchema),
});
export type FleetHealthSnapshot = z.infer<typeof FleetHealthSnapshotSchema>;

export interface FleetHealthClock {
  now(): number;
}

/**
 * Collect account liveness without inferring a healthy result from missing evidence.
 * An explicitly unavailable account and an adapter exception are both `unknown`; neither is
 * permission to route work, and neither is evidence that the provider is down.
 */
export class FleetHealthCollector {
  constructor(
    private readonly probe: FleetHealthProbe,
    private readonly clock: FleetHealthClock,
  ) {}

  async collect(manifest: FleetManifest): Promise<FleetHealthSnapshot> {
    const rows = await Promise.all(
      [...manifest.accounts]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map(async account => await this.#collect(account)),
    );
    return FleetHealthSnapshotSchema.parse({ at: this.#now(), accounts: rows });
  }

  async #collect(account: FleetManifestAccount): Promise<FleetHealth> {
    if (!account.available) {
      return {
        accountId: account.id,
        kind: account.kind,
        state: 'unknown',
        cached: false,
        checkedAt: this.#now(),
        ms: 0,
        error: account.unavailableReason ?? 'the manifest declares this account unavailable',
      };
    }
    try {
      const result = FleetHealthProbeResultSchema.parse(await this.probe.probe(account));
      return FleetHealthSchema.parse({ accountId: account.id, kind: account.kind, ...result });
    } catch (error) {
      return {
        accountId: account.id,
        kind: account.kind,
        state: 'unknown',
        cached: false,
        checkedAt: this.#now(),
        ms: 0,
        error: error instanceof Error && error.message ? error.message : 'health probe could not run',
      };
    }
  }

  #now(): number {
    const now = this.clock.now();
    if (!Number.isFinite(now) || now < 0) throw new Error('the fleet clock did not return a valid instant');
    return Math.trunc(now);
  }
}

/** The only construction path, so both CLI and daemon honour health configuration. */
export function buildFleetHealthCollector(
  _config: FleetConfig,
  probe: FleetHealthProbe,
  clock: FleetHealthClock,
): FleetHealthCollector {
  return new FleetHealthCollector(probe, clock);
}
