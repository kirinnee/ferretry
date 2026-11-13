/**
 * FERRET LIMITS — how much of the machine the ferrets may take, so the daemon stays reachable
 * (docs/ferret-limits.md).
 *
 * One configuration file and one read-only view:
 *
 * - `limits.yaml` — every setting optional. A setting that is absent is COMPUTED from the machine
 *   ({@link resolveLimits}); a setting that is written wins. {@link LimitsFile}.
 * - `GET /v1/cgroups/config` — what is in force and why, in plain words ({@link LimitsView}).
 *
 * THE MATH LIVES HERE, once. The daemon turns {@link ResolvedLimits} into unit properties; the config
 * check turns two files into "did this raise a cap"; the app and `fy` print
 * the daemon's own sentences. Three programs that must agree on what "the default" is read it from here.
 *
 * Pure: no IO, no clock, no globals.
 */
import { z } from 'zod';
import { NonNegativeIntegerSchema, PositiveIntegerSchema } from '@ferretry/std';

/** One binary gigabyte. Every size in this module is in bytes; "G" in a file means this. */
export const GIBIBYTE = 1024 ** 3;

// ── Sizes ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A size as written in `limits.yaml`: a byte count, a size string (`40G`, `512M`, `1.5GiB`), a percent
 * of the user's memory budget (`25%`), or `infinity` for no cap.
 */
type LimitSizeText = number | string;

/** What a written size means. */
type ParsedLimitSize =
  | { readonly kind: 'bytes'; readonly bytes: number }
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'unlimited' };

const UNIT_BYTES: Readonly<Record<string, number>> = {
  K: 1024,
  M: 1024 ** 2,
  G: GIBIBYTE,
  T: 1024 ** 4,
};

/** `40G`, `1.5 GiB`, `512m`, `25%`: a number, optional space, then a unit. A bare number is bytes. */
const SIZE_TEXT = /^(\d+(?:\.\d+)?)\s*(%|[KMGT](?:i?B)?|B)?$/iu;

/** What a written size means, or `undefined` when it is not a size. Total over every value. */
function parseLimitSize(value: unknown): ParsedLimitSize | undefined {
  if (typeof value === 'number')
    return Number.isInteger(value) && value > 0 ? { kind: 'bytes', bytes: value } : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.toLowerCase() === 'infinity') return { kind: 'unlimited' };
  const match = SIZE_TEXT.exec(text);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  if (!(amount > 0)) return undefined;
  if (unit === '%') return amount <= 100 ? { kind: 'percent', percent: amount } : undefined;
  const bytes = Math.floor(amount * (unit === 'B' ? 1 : (UNIT_BYTES[unit.slice(0, 1)] ?? 0)));
  return bytes >= 1 ? { kind: 'bytes', bytes } : undefined;
}

const SizeSchema = z
  .union([z.number().int().positive(), z.string()])
  .refine(value => parseLimitSize(value) !== undefined, {
    message: 'write a size such as 40G or 512M, a percent of the memory budget such as 25%, a byte count, or infinity',
  });

const WeightSchema = z.number().int().min(1).max(10_000);
const TasksSchema = z.union([z.number().int().min(1).max(4_194_304), z.literal('infinity')]);
/** A hard CPU ceiling as a share of the WHOLE machine; absent means none, because a quota idles cores. */
const CpuPercentSchema = z.number().finite().gt(0).max(100);

// ── limits.yaml ──────────────────────────────────────────────────────────────────────────────────

/** The caps on all ferrets taken together (`<product>_fleet.slice`). */
const FleetLimitsFileSchema = z.strictObject({
  /** CPU share against the daemon (100) and voice (200) when the machine is busy. */
  cpuWeight: WeightSchema.optional(),
  /** Past this the kernel slows every ferret down to reclaim memory. */
  memoryHigh: SizeSchema.optional(),
  /** Past this the kernel stops a process inside the fleet. */
  memoryMax: SizeSchema.optional(),
  /** Swap the fleet may use; thrashing swap is what saturates the disk. */
  swapMax: SizeSchema.optional(),
  tasksMax: TasksSchema.optional(),
  cpuPercent: CpuPercentSchema.optional(),
});

/** The caps on each ferret (`<product>-agent-*.scope`). */
const FerretLimitsFileSchema = z.strictObject({
  cpuWeight: WeightSchema.optional(),
  /** The weight of a ferret a person started, so their own ferret beats a sub-ferret. */
  interactiveCpuWeight: WeightSchema.optional(),
  memoryHigh: SizeSchema.optional(),
  memoryMax: SizeSchema.optional(),
  tasksMax: TasksSchema.optional(),
  cpuPercent: CpuPercentSchema.optional(),
});

const LimitsFileSchema = z.strictObject({
  /** The switch. Absent means on; `false` is held for the owner to confirm. */
  enabled: z.boolean().optional(),
  fleet: FleetLimitsFileSchema.optional(),
  perFerret: FerretLimitsFileSchema.optional(),
  /** Run harnesses at the lowest best-effort disk priority. Absent means on; `false` is held. */
  ionice: z.boolean().optional(),
});
type LimitsFile = z.infer<typeof LimitsFileSchema>;

/** What a machine with no `limits.yaml` behaves as: limits on, every number computed. */
export type LimitsConfig = LimitsFile;

// ── The numbers ──────────────────────────────────────────────────────────────────────────────────

/**
 * The CPU weights this product assigns. The voice slice's is what it will be given when it starts; the
 * daemon's own is NOT a constant here — its unit sets it, so the view reads it back from the kernel.
 */
export const VOICE_CPU_WEIGHT = 200;
const DEFAULT_FLEET_CPU_WEIGHT = 50;
const DEFAULT_FERRET_CPU_WEIGHT = 100;
const DEFAULT_INTERACTIVE_CPU_WEIGHT = 200;
const DEFAULT_FLEET_TASKS_MAX = 16_384;
const DEFAULT_FERRET_TASKS_MAX = 4_096;

/** What the machine gives the user to spend. Measured by the daemon (`memoryCeilingBytes`). */
export interface LimitsHost {
  /** min(physical RAM, every finite memory.max and memory.high above the daemon). */
  readonly memoryCeilingBytes: number;
}

/** A number of bytes or tasks, `null` when there is no cap. */
export type Cap = number | null;

export interface ResolvedFleetLimits {
  readonly cpuWeight: number;
  readonly memoryHigh: Cap;
  readonly memoryMax: Cap;
  readonly swapMax: Cap;
  readonly tasksMax: Cap;
  /** Share of the whole machine as a percent, or `null` for no quota (the default). */
  readonly cpuPercent: number | null;
}

export interface ResolvedFerretLimits {
  readonly cpuWeight: number;
  readonly interactiveCpuWeight: number;
  readonly memoryHigh: Cap;
  readonly memoryMax: Cap;
  readonly tasksMax: Cap;
  readonly cpuPercent: number | null;
}

export interface ResolvedLimits {
  readonly enabled: boolean;
  readonly ionice: boolean;
  /** Memory kept back for the daemon and the person's own shell. */
  readonly reserveBytes: number;
  readonly fleet: ResolvedFleetLimits;
  readonly perFerret: ResolvedFerretLimits;
  /** Settings that were adjusted to stay coherent, in plain words. */
  readonly warnings: readonly string[];
}

/**
 * Memory held back from the fleet for the daemon and the rest of the system: a FIXED 4 GiB (owner decision
 * !A419), but never more than half the budget — a small machine still has to give its ferrets something to
 * run in. It is not a share of the budget: the daemon needs the same few gigabytes on a 16 GiB laptop and a
 * 128 GiB server.
 */
export const FLEET_RESERVE_BYTES = 4 * GIBIBYTE;

export function reserveBytes(ceilingBytes: number): number {
  return Math.floor(Math.min(FLEET_RESERVE_BYTES, ceilingBytes / 2));
}

function sizeCap(value: LimitSizeText | undefined, ceilingBytes: number, fallback: Cap): Cap {
  const parsed = value === undefined ? undefined : parseLimitSize(value);
  if (parsed === undefined) return fallback;
  if (parsed.kind === 'unlimited') return null;
  if (parsed.kind === 'bytes') return parsed.bytes;
  return Math.max(1, Math.floor((parsed.percent / 100) * ceilingBytes));
}

function taskCap(value: number | 'infinity' | undefined, fallback: number): Cap {
  if (value === undefined) return fallback;
  return value === 'infinity' ? null : value;
}

/**
 * What a configuration means on this machine: every absent setting replaced by its computed default.
 *
 * The defaults, with R = {@link reserveBytes}: the fleet gets `CPUWeight=50`, a soft memory limit of
 * budget − R (R is a fixed 4 GiB), a hard one of budget − R/2, swap of 10 % of the budget and 16384 tasks; each ferret gets
 * a soft limit of 25 % of the budget, a hard one of 30 %, 4096 tasks and weight 100 (200 if a person
 * started it). There is no CPU quota unless one is written.
 */
export function resolveLimits(config: LimitsConfig, host: LimitsHost): ResolvedLimits {
  const ceiling = Math.max(1, Math.floor(host.memoryCeilingBytes));
  const reserve = reserveBytes(ceiling);
  const fleetIn = config.fleet ?? {};
  const ferretIn = config.perFerret ?? {};
  const warnings: string[] = [];
  const bound = (high: Cap, max: Cap, who: string): Cap => {
    if (high !== null && max !== null && high > max) {
      warnings.push(`${who} soft memory limit is above its hard limit, so the hard limit is used for both`);
      return max;
    }
    return high;
  };
  const fleetMax = sizeCap(fleetIn.memoryMax, ceiling, ceiling - Math.floor(reserve / 2));
  const fleetHigh = bound(sizeCap(fleetIn.memoryHigh, ceiling, ceiling - reserve), fleetMax, 'the fleet’s');
  const ferretMax = sizeCap(ferretIn.memoryMax, ceiling, Math.floor(ceiling * 0.3));
  const ferretHigh = bound(
    sizeCap(ferretIn.memoryHigh, ceiling, Math.floor(ceiling * 0.25)),
    ferretMax,
    'each ferret’s',
  );
  return {
    enabled: config.enabled ?? true,
    ionice: config.ionice ?? true,
    reserveBytes: reserve,
    fleet: {
      cpuWeight: fleetIn.cpuWeight ?? DEFAULT_FLEET_CPU_WEIGHT,
      memoryHigh: fleetHigh,
      memoryMax: fleetMax,
      swapMax: sizeCap(fleetIn.swapMax, ceiling, Math.floor(ceiling * 0.1)),
      tasksMax: taskCap(fleetIn.tasksMax, DEFAULT_FLEET_TASKS_MAX),
      cpuPercent: fleetIn.cpuPercent ?? null,
    },
    perFerret: {
      cpuWeight: ferretIn.cpuWeight ?? DEFAULT_FERRET_CPU_WEIGHT,
      interactiveCpuWeight: ferretIn.interactiveCpuWeight ?? DEFAULT_INTERACTIVE_CPU_WEIGHT,
      memoryHigh: ferretHigh,
      memoryMax: ferretMax,
      tasksMax: taskCap(ferretIn.tasksMax, DEFAULT_FERRET_TASKS_MAX),
      cpuPercent: ferretIn.cpuPercent ?? null,
    },
    warnings,
  };
}

// ── The view ─────────────────────────────────────────────────────────────────────────────────────

const NullableBytes = NonNegativeIntegerSchema.nullable();

/** What kind of enforcement this machine gives. */
const LIMITS_ENFORCEMENTS = ['cgroups', 'priority', 'none'] as const;
const LimitsEnforcementSchema = z.enum(LIMITS_ENFORCEMENTS);

/** Whether disk priority can do anything on the disk the state home is on. */
const LIMITS_DISK_EFFECTS = ['full', 'class-only', 'none', 'unknown'] as const;
const LimitsDiskEffectSchema = z.enum(LIMITS_DISK_EFFECTS);
export type LimitsDiskEffect = z.infer<typeof LimitsDiskEffectSchema>;

const FleetLimitsViewFields = z.object({
  cpuWeight: PositiveIntegerSchema.optional(),
  memoryHighBytes: NullableBytes.optional(),
  memoryMaxBytes: NullableBytes.optional(),
  swapMaxBytes: NullableBytes.optional(),
  tasksMax: NullableBytes.optional(),
  cpuPercent: z.number().finite().nullable().optional(),
});
const FerretLimitsViewFields = z.object({
  cpuWeight: PositiveIntegerSchema.optional(),
  interactiveCpuWeight: PositiveIntegerSchema.optional(),
  memoryHighBytes: NullableBytes.optional(),
  memoryMaxBytes: NullableBytes.optional(),
  tasksMax: NullableBytes.optional(),
  cpuPercent: z.number().finite().nullable().optional(),
});

export const LimitsViewSchema = z.object({
  /** Limits are on, off by `enabled: false`, or cannot be applied here. */
  switchedOn: z.boolean(),
  /** `cgroups` on Linux, `priority` on macOS, `none` when nothing is enforced. */
  enforcement: LimitsEnforcementSchema,
  /** Why nothing (or less than usual) is enforced, in plain words; absent when all is well. */
  notEnforcedBecause: z.string().min(1).optional(),
  /** The owner wrote `enabled: true` themselves, so a launch that cannot be limited fails. */
  explicit: z.boolean(),
  platform: z.string().min(1),
  budget: z.object({
    ceilingBytes: PositiveIntegerSchema,
    physicalBytes: PositiveIntegerSchema,
    swapBytes: NonNegativeIntegerSchema,
    cpus: PositiveIntegerSchema,
    pidMax: PositiveIntegerSchema.optional(),
    /** What set the ceiling: the RAM, or the cgroup that caps this user. */
    source: z.string().min(1),
    reserveBytes: NonNegativeIntegerSchema,
  }),
  /** Applied values only: absent fields could not be read back. */
  fleet: FleetLimitsViewFields,
  perFerret: FerretLimitsViewFields,
  /** Configured defaults for the next launch, separate from running limits. */
  configured: z
    .object({ fleet: FleetLimitsViewFields.required(), perFerret: FerretLimitsViewFields.required() })
    .optional(),
  /** The CPU weight the kernel holds for the daemon's own cgroup; absent when it could not be read. */
  daemonCpuWeight: PositiveIntegerSchema.optional(),
  /** The voice slice's weight as the kernel holds it; absent unless the voice worker is running and readable. */
  voiceCpuWeight: PositiveIntegerSchema.optional(),
  /** Whether the voice worker's slice is live (so `voiceCpuWeight` is applied); absent where there are no cgroups. */
  voiceState: z.enum(['running', 'not-running', 'unknown']).optional(),
  disk: z.object({
    ionice: z.boolean(),
    scheduler: z.string().optional(),
    effect: LimitsDiskEffectSchema,
  }),
  /** Ferrets slowed for memory right now. */
  throttled: z.array(z.object({ sessionId: z.string().min(1), callsign: z.string().optional() })),
  /** The latest ferrets something inside which was killed for memory. */
  killed: z.array(
    z.object({
      sessionId: z.string().min(1),
      callsign: z.string().optional(),
      at: z.string().min(1),
      /** What died, when known (`bun test`). */
      what: z.string().optional(),
      bytes: NonNegativeIntegerSchema.optional(),
    }),
  ),
  /** macOS only: ferrets over their per-ferret memory share now. Watched, not capped. */
  overBudget: z.array(
    z.object({ sessionId: z.string().min(1), callsign: z.string().optional(), bytes: NonNegativeIntegerSchema }),
  ),
  /** The file the owner edits, relative to the config directory. */
  file: z.string().min(1),
  /** The plain-words lines `fy daemon status` and the app both print, verbatim. */
  lines: z.array(z.string().min(1)),
  /**
   * Set when a cap above the daemon holds the user below the machine's RAM: the exact one-time commands an
   * owner can run to lift it. Generated from the machine's own facts; never run by Ferretry.
   */
  ownerStep: z.array(z.string().min(1)).optional(),
  warnings: z.array(z.string()),
});
export type LimitsView = z.infer<typeof LimitsViewSchema>;
