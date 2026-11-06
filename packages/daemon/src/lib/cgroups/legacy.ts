/**
 * THE ONE-TIME MOVE FROM `cgroups/config.json` TO `limits.yaml`.
 *
 * Limits used to be opt-in and lived in a JSON document in the state home that the app's settings panel
 * wrote. They are on by default now and configured in the machine's YAML like everything else, so the old
 * document is RETIRED, once, and nothing the operator chose is lost:
 *
 * - `enabled` is carried either way (a document that said `true` keeps meaning on — and, being the
 *   owner's own word, is the explicit kind that fails a launch rather than run unlimited);
 * - a percentage that is not the old default becomes the matching cap, as a percent of the user's
 *   budget; a default is NOT carried, because the defaults are computed now and carrying a stale one
 *   would freeze it;
 * - the old file is kept beside itself as `config.json.migrated`, so nothing is destroyed.
 *
 * A document that does not validate is left exactly where it is, and said so.
 *
 * Writes go through the configuration writer every editor uses, so the new file is checked like any
 * other; what the migration writes is never looser than what the operator had saved.
 */
import { editConfigText } from '@ferretry/fleet/config-text';
import { configSchemaModeline, type LimitsFile } from '@ferretry/protocol';
import { z } from 'zod';

const OLD_DEFAULT_FLEET = { cpuPercent: 90, memoryPercent: 90 };
const OLD_DEFAULT_PER_AGENT = { cpuPercent: 25, memoryPercent: 25 };

const LimitSchema = z.object({
  cpuPercent: z.number().finite().gt(0).max(100),
  memoryPercent: z.number().finite().gt(0).max(100),
});
const LegacySchema = z.object({ enabled: z.boolean(), fleet: LimitSchema, perAgent: LimitSchema });

/** What the old document means as `limits.yaml`, or `undefined` when it is not a legacy document. */
export function legacyLimitsFile(raw: unknown): LimitsFile | undefined {
  const parsed = LegacySchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { enabled, fleet, perAgent } = parsed.data;
  const changed = (value: number, old: number): boolean => value !== old;
  const fleetFile: NonNullable<LimitsFile['fleet']> = {
    ...(changed(fleet.memoryPercent, OLD_DEFAULT_FLEET.memoryPercent) ? { memoryMax: `${fleet.memoryPercent}%` } : {}),
    ...(changed(fleet.cpuPercent, OLD_DEFAULT_FLEET.cpuPercent) ? { cpuPercent: fleet.cpuPercent } : {}),
  };
  const ferretFile: NonNullable<LimitsFile['perFerret']> = {
    ...(changed(perAgent.memoryPercent, OLD_DEFAULT_PER_AGENT.memoryPercent)
      ? { memoryMax: `${perAgent.memoryPercent}%` }
      : {}),
    ...(changed(perAgent.cpuPercent, OLD_DEFAULT_PER_AGENT.cpuPercent) ? { cpuPercent: perAgent.cpuPercent } : {}),
  };
  return {
    enabled,
    ...(Object.keys(fleetFile).length === 0 ? {} : { fleet: fleetFile }),
    ...(Object.keys(ferretFile).length === 0 ? {} : { perFerret: ferretFile }),
  };
}

export interface LegacyLimitsPorts {
  /** The old document's parsed JSON, or `undefined` when there is none. */
  readOld(): Promise<unknown>;
  /** `limits.yaml` as it is now. */
  readLimits(): Promise<{ readonly exists: boolean; readonly text: string; readonly etag: string }>;
  /** Writes `limits.yaml` through the configuration writer, against `etag`. */
  writeLimits(text: string, etag: string): Promise<void>;
  /** Keeps the old document as `config.json.migrated` and removes it (and its apply record). */
  retireOld(): Promise<void>;
}

export type LegacyLimitsOutcome =
  | { readonly outcome: 'nothing' }
  | { readonly outcome: 'migrated'; readonly file: LimitsFile }
  | { readonly outcome: 'kept'; readonly because: string };

export class LegacyLimitsMigration {
  constructor(private readonly ports: LegacyLimitsPorts) {}

  async run(): Promise<LegacyLimitsOutcome> {
    const raw = await this.ports.readOld();
    if (raw === undefined) return { outcome: 'nothing' };
    const file = legacyLimitsFile(raw);
    if (file === undefined)
      return {
        outcome: 'kept',
        because: 'cgroups/config.json does not look like an old limits document, so it was left alone',
      };
    const current = await this.ports.readLimits();
    // An existing limits.yaml is the operator's newer word: the old document is only retired.
    if (!current.exists) {
      const body = file as Record<string, unknown>;
      await this.ports.writeLimits(
        editConfigText(undefined, body, {}, configSchemaModeline({ kind: 'limits' })),
        current.etag,
      );
    }
    await this.ports.retireOld();
    return { outcome: 'migrated', file };
  }
}
