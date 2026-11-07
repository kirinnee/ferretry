import { defineConfig, defineState } from '@ferretry/kernel/contract';
import { JsonValueSchema } from '@ferretry/std';
import { z } from 'zod';
import { FerretIdSchema, FerretRecordSchema } from './ids.ts';
import { IsoInstantSchema, StoredSessionIdSchema } from './records.ts';
import { SessionForkReceiptSchema } from './transfer.ts';

/** Ferrets' declared files (§9.2). Every JSON document has `format: 1` first. */

export const FerretFiles = defineState({
  name: 'ferret',
  path: '*/ferret.json',
  store: 'json',
  format: 1,
  schema: FerretRecordSchema,
});

// ─── history.jsonl (today's `lib/journal.ts` event record) ──────────────────────────────────────────────────────

/**
 * One line of a ferret's `history.jsonl`: today's stored journal event. The sequence is strictly increasing within one
 * journal; the record cap and the canonical `data` are the daemon's journal module's (`daemon/lib/storage/journal.ts`).
 */
export const FerretHistoryEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().safe().positive(),
  sessionId: StoredSessionIdSchema,
  time: IsoInstantSchema,
  type: z
    .string()
    .min(1)
    .refine(value => value.trim() === value, 'event type must not have surrounding whitespace'),
  data: JsonValueSchema,
});
export type FerretHistoryEvent = z.infer<typeof FerretHistoryEventSchema>;

export const FerretHistoryFiles = defineState({
  name: 'history',
  path: '*/history.jsonl',
  store: 'jsonl',
  format: 1,
  schema: FerretHistoryEventSchema,
});

/** `tokens.json`: SHA-256 digests of each ferret's `fys_` token, never a token (Gate asks through `bearers:ferret`). */
export const FerretTokensSchema = z.strictObject({
  format: z.literal(1),
  tokens: z.array(
    z.strictObject({
      ferret: FerretIdSchema,
      digest: z.string().regex(/^[0-9a-f]{64}$/u),
      issuedAt: z.string().min(1),
      revoked: z.literal(true).optional(),
    }),
  ),
});
export const FerretTokensFile = defineState({
  name: 'tokens',
  path: 'tokens.json',
  store: 'json',
  format: 1,
  schema: FerretTokensSchema,
  mode: 0o600,
});
// ─── names.json (today's callsign claim ledger, `adapters/names/file-name-claim-store.ts`) ────────────────────────

/** The longest callsign (today's `lib/names/types.ts`). */
export const MAX_CALLSIGN_LENGTH = 32;
const CALLSIGN_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A callsign in its one stored spelling: trimmed, lowercase, a letter then letters, digits or hyphens; else `null`. */
export function normalizeCallsign(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_CALLSIGN_LENGTH) return null;
  return CALLSIGN_PATTERN.test(normalized) ? normalized : null;
}

// STRICT so an unknown field on a ledger row fails closed. Zod's default strip mode would accept the
// row, drop the extra field, and silently rewrite it on the next successful claim — hiding exactly
// the tampering or corruption the damaged-ledger cases exist to surface.
export const NameClaimSchema = z
  .strictObject({
    callsign: z.string().refine(callsign => normalizeCallsign(callsign) === callsign, 'callsign is not canonical'),
    ownerId: z.string().min(1),
    claimedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .refine(claim => claim.expiresAtMs > claim.claimedAtMs, 'claim expiry must be after its creation');

/**
 * `names.json`: today's claim ledger, the reservations a start holds on a callsign before its record exists. Today the
 * file was the bare array of claims; a state document is an object with `format` first, so the claims sit under
 * `claims`.
 */
export const NamesDocumentSchema = z.strictObject({ claims: z.array(NameClaimSchema) });
export type NamesDocument = z.infer<typeof NamesDocumentSchema>;
export const NamesFile = defineState({
  name: 'names',
  path: 'names.json',
  store: 'json',
  format: 1,
  schema: NamesDocumentSchema,
});

// ─── archive.json (today's archive registry, `lib/session/archive/registry.ts`) ────────────────────────────────

/** What stands in for a journal file's identity, as the index and the archive record it. */
export const JournalFingerprintSchema = z.strictObject({
  device: z.string(),
  inode: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAtMs: z.number().nonnegative(),
});

/** One archived ferret: when it left the live set, and the index row it had. */
export const ArchivedFerretSchema = z.strictObject({
  archivedAt: IsoInstantSchema,
  /** The agent name the session answered to (`config.teammate`), so a name still addresses it. */
  name: z.string().optional(),
  /** The configuration's own `createdAt` and `updatedAt`, which a callsign's hold on its name is measured from. */
  configCreatedAt: z.string().optional(),
  configUpdatedAt: z.string().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastSequence: z.number().int().nonnegative(),
  journalLine: z.number().int().positive(),
  journal: JournalFingerprintSchema.nullable(),
});

/**
 * `archive.json`: one entry per archived ferret, by id. The state port stamps and checks `format: 1`, so the body
 * carries no `version` of its own (today's carried `version: 1`).
 */
export const ArchiveDocumentSchema = z.strictObject({
  sessions: z.record(z.string(), ArchivedFerretSchema),
});
export type ArchiveDocument = z.infer<typeof ArchiveDocumentSchema>;
export const ArchiveFile = defineState({
  name: 'archive',
  path: 'archive.json',
  store: 'json',
  format: 1,
  schema: ArchiveDocumentSchema,
});
export const AutoResumeFile = defineState({ name: 'auto-resume', path: 'auto-resume.json', store: 'json', format: 1 });
export const RestartsFile = defineState({ name: 'restarts', path: 'restarts.json', store: 'json', format: 1 });
// ─── worktrees.json (today's managed worktree registry, `lib/worktrees/registry.ts`) ────────────────────────────

export const ManagedWorktreeRecordSchema = z.strictObject({
  version: z.literal(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  gitDir: z.string().min(1),
  ownershipToken: z.string().min(1),
  createdAt: z.string().min(1),
  initialHead: z.string().min(1),
  branchPreexisted: z.boolean(),
  sourceCwd: z.string().min(1),
  relativeCwd: z.string(),
  ownerSessionId: z.string().min(1).optional(),
  removalStartedAt: z.string().min(1).optional(),
  removedAt: z.string().min(1).optional(),
});

export const ManagedWorktreeIntentSchema = z.strictObject({
  version: z.literal(1),
  path: z.string().min(1),
  branch: z.string().min(1),
  repositoryRoot: z.string().min(1),
  commonDir: z.string().min(1),
  ownershipToken: z.string().min(1),
  declaredAt: z.string().min(1),
  initialHead: z.string().min(1),
  branchPreexisted: z.boolean(),
  sourceCwd: z.string().min(1),
  relativeCwd: z.string(),
  ownerSessionId: z.string().min(1).optional(),
});

/**
 * `state/ferrets/worktrees.json` (§9.2, the contract's `WorktreesFile`). Its `format: 1` is stamped and checked by the
 * kernel's state port, so the document here is the body only.
 */
export const ManagedWorktreeDocumentSchema = z.strictObject({
  worktrees: z.array(ManagedWorktreeRecordSchema),
  intents: z.array(ManagedWorktreeIntentSchema),
});
export type ManagedWorktreeDocument = z.infer<typeof ManagedWorktreeDocumentSchema>;
export const WorktreesFile = defineState({
  name: 'worktrees',
  path: 'worktrees.json',
  store: 'json',
  format: 1,
  schema: ManagedWorktreeDocumentSchema,
});

/** `forks/<planId>.json`: one fork receipt each (`./transfer.ts`, today's `lib/fork/receipt.ts`). */
export const ForkFiles = defineState({
  name: 'forks',
  path: 'forks/*.json',
  store: 'json',
  format: 1,
  schema: SessionForkReceiptSchema,
});
export const MoveFiles = defineState({ name: 'moves', path: 'moves/*.json', store: 'json', format: 1 });
export const LimitsAppliedFile = defineState({
  name: 'limits-applied',
  path: 'limits-applied.json',
  store: 'json',
  format: 1,
});
export const FerretIndexFile = defineState({ name: 'index', path: 'index.sqlite', store: 'sqlite-cache', format: 1 });

// ─── limits.yaml (today's `protocol/src/lib/limits.ts`) ───────────────────────────────────────────────────────────

const SIZE_TEXT = /^(\d+(?:\.\d+)?)\s*(%|[KMGT](?:i?B)?|B)?$/iu;
const UNIT_BYTES: Readonly<Record<string, number>> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };

export type ParsedLimitSize =
  | { readonly kind: 'bytes'; readonly bytes: number }
  | { readonly kind: 'percent'; readonly percent: number }
  | { readonly kind: 'unlimited' };

/** Today's `parseLimitSize`. */
export function parseLimitSize(value: unknown): ParsedLimitSize | undefined {
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
const CpuPercentSchema = z.number().finite().gt(0).max(100);

export const FleetLimitsSchema = z.strictObject({
  cpuWeight: WeightSchema.optional(),
  memoryHigh: SizeSchema.optional(),
  memoryMax: SizeSchema.optional(),
  swapMax: SizeSchema.optional(),
  tasksMax: TasksSchema.optional(),
  cpuPercent: CpuPercentSchema.optional(),
});
export const FerretLimitsSchema = z.strictObject({
  cpuWeight: WeightSchema.optional(),
  interactiveCpuWeight: WeightSchema.optional(),
  memoryHigh: SizeSchema.optional(),
  memoryMax: SizeSchema.optional(),
  tasksMax: TasksSchema.optional(),
  cpuPercent: CpuPercentSchema.optional(),
});
export const LimitsFileSchema = z.strictObject({
  enabled: z.boolean().optional(),
  fleet: FleetLimitsSchema.optional(),
  perFerret: FerretLimitsSchema.optional(),
  ionice: z.boolean().optional(),
});
export type LimitsFile = z.infer<typeof LimitsFileSchema>;

// ── Loosening (today's `resolveLimits` + `limitsLoosening`, protocol/src/lib/limits.ts:154–:317) ──────────────────

const GIBIBYTE = 1024 ** 3;
const DEFAULT_FLEET_CPU_WEIGHT = 50;
const DEFAULT_FERRET_CPU_WEIGHT = 100;
const DEFAULT_INTERACTIVE_CPU_WEIGHT = 200;
const DEFAULT_FLEET_TASKS_MAX = 16_384;
const DEFAULT_FERRET_TASKS_MAX = 4_096;
/** Memory held back from the fleet: a fixed 4 GiB, never more than half the budget (owner decision !A419). */
const FLEET_RESERVE_BYTES = 4 * GIBIBYTE;

/** A number of bytes or tasks, `null` when there is no cap. */
type Cap = number | null;

const reserveBytes = (ceilingBytes: number): number => Math.floor(Math.min(FLEET_RESERVE_BYTES, ceilingBytes / 2));

function sizeCap(value: number | string | undefined, ceilingBytes: number, fallback: Cap): Cap {
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

/** What a configuration means on a machine with this budget: every absent setting replaced by its computed default. */
function resolveLimits(config: LimitsFile, memoryCeilingBytes: number) {
  const ceiling = Math.max(1, Math.floor(memoryCeilingBytes));
  const reserve = reserveBytes(ceiling);
  const fleetIn = config.fleet ?? {};
  const ferretIn = config.perFerret ?? {};
  const bound = (high: Cap, max: Cap): Cap => (high !== null && max !== null && high > max ? max : high);
  const fleetMax = sizeCap(fleetIn.memoryMax, ceiling, ceiling - Math.floor(reserve / 2));
  const fleetHigh = bound(sizeCap(fleetIn.memoryHigh, ceiling, ceiling - reserve), fleetMax);
  const ferretMax = sizeCap(ferretIn.memoryMax, ceiling, Math.floor(ceiling * 0.3));
  const ferretHigh = bound(sizeCap(ferretIn.memoryHigh, ceiling, Math.floor(ceiling * 0.25)), ferretMax);
  return {
    enabled: config.enabled ?? true,
    ionice: config.ionice ?? true,
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
  };
}

/** Words for each cap, so a held change reads as a sentence the owner can confirm. */
const FLEET_WORDS = {
  cpuWeight: 'the CPU weight of all ferrets together',
  memoryHigh: 'the soft memory limit for all ferrets together',
  memoryMax: 'the hard memory limit for all ferrets together',
  swapMax: 'the swap all ferrets together may use',
  tasksMax: 'the processes all ferrets together may run',
  cpuPercent: 'the CPU share all ferrets together may use',
} as const;

const FERRET_WORDS = {
  cpuWeight: 'the CPU weight of each ferret',
  interactiveCpuWeight: 'the CPU weight of a ferret you started',
  memoryHigh: 'the soft memory limit of each ferret',
  memoryMax: 'the hard memory limit of each ferret',
  tasksMax: 'the processes each ferret may run',
  cpuPercent: 'the CPU share each ferret may use',
} as const;

/** A cap's comparable form when the budget is known: bytes or a count, `Infinity` for none. */
const comparable = (cap: Cap | undefined): number => (cap === null ? Number.POSITIVE_INFINITY : (cap ?? 0));

/**
 * One setting compared WITHOUT knowing the budget. Only edits that are provably not looser pass: the same unit
 * written lower, a percent under the default's own percent written where nothing was, no change. A change of unit,
 * or going back to the computed default, cannot be proved tighter, so it is held.
 */
function symbolicRaised(before: unknown, after: unknown, defaultPercent: number | undefined): boolean {
  if (before === after || JSON.stringify(before) === JSON.stringify(after)) return false;
  if (after === undefined) return true;
  if (before === undefined) {
    // Nothing was written, so the baseline is the computed default, which needs the budget. Only a percent that
    // sits under the default's own percent is provably tighter; `infinity`, bytes, and any percent above it cannot
    // be shown to be below the default, so they are held.
    const added = parseLimitSize(after);
    return !(added?.kind === 'percent' && defaultPercent !== undefined && added.percent <= defaultPercent);
  }
  const was = parseLimitSize(before);
  const now = parseLimitSize(after);
  if (was === undefined || now === undefined)
    return typeof after === 'number' && typeof before === 'number' && after > before;
  if (now.kind === 'unlimited') return was.kind !== 'unlimited';
  if (was.kind === 'unlimited') return false;
  if (was.kind !== now.kind) return true;
  return was.kind === 'bytes'
    ? now.kind === 'bytes' && now.bytes > was.bytes
    : now.kind === 'percent' && now.percent > was.percent;
}

const SIZE_FIELDS = new Set(['memoryHigh', 'memoryMax', 'swapMax']);

/** The computed defaults that are a fixed percent of the budget, by `group.field`; the others need the budget. */
const DEFAULT_PERCENTS: Readonly<Record<string, number>> = {
  'fleet.swapMax': 10,
  'perFerret.memoryHigh': 25,
  'perFerret.memoryMax': 30,
};

/** Today's `limitsLoosening`, verbatim: with the budget known it compares what each file RESOLVES to. */
function limitsLoosening(before: LimitsFile, after: LimitsFile, ceilingBytes?: number): readonly string[] {
  const sentences: string[] = [];
  const was = resolveLimits(before, ceilingBytes ?? GIBIBYTE);
  const now = resolveLimits(after, ceilingBytes ?? GIBIBYTE);
  if (was.enabled && !now.enabled)
    sentences.push('ferret limits are switched off, so ferrets may take all of the machine');
  if (was.ionice && !now.ionice) sentences.push('ferrets no longer run at a lower disk priority');
  const check = (
    group: 'fleet' | 'perFerret',
    field: string,
    words: string,
    resolvedBefore: Cap | number | undefined,
    resolvedAfter: Cap | number | undefined,
  ): void => {
    const writtenBefore = (before[group] as Record<string, unknown> | undefined)?.[field];
    const writtenAfter = (after[group] as Record<string, unknown> | undefined)?.[field];
    const raised =
      ceilingBytes !== undefined || !SIZE_FIELDS.has(field)
        ? comparable(resolvedAfter as Cap) > comparable(resolvedBefore as Cap)
        : symbolicRaised(writtenBefore, writtenAfter, DEFAULT_PERCENTS[`${group}.${field}`]);
    if (raised) sentences.push(`${words} was raised`);
  };
  for (const field of Object.keys(FLEET_WORDS) as (keyof typeof FLEET_WORDS)[])
    check('fleet', field, FLEET_WORDS[field], was.fleet[field], now.fleet[field]);
  for (const field of Object.keys(FERRET_WORDS) as (keyof typeof FERRET_WORDS)[])
    check('perFerret', field, FERRET_WORDS[field], was.perFerret[field], now.perFerret[field]);
  return sentences;
}

/**
 * Which `limits.yaml` edits loosen (docs/ferret-limits.md: raising a cap is held for the owner): raising any cap or
 * weight, taking a cap away, switching limits off and turning disk priority off. A config check carries no host
 * budget, so this is today's conservative comparison: absent settings resolve to their computed defaults, and a
 * size edit passes only when it is provably not looser (a change of unit, or a written cap replacing a default
 * that is not a fixed percent, is held).
 */
export function limitsLoosen(before: LimitsFile | undefined, after: LimitsFile): readonly string[] {
  return limitsLoosening(before ?? {}, after);
}

export const LimitsConfigFile = defineConfig({
  file: 'limits.yaml',
  schema: LimitsFileSchema,
  axis: 'configure',
  loosens: limitsLoosen,
});

/** `config/instructions/<name>.md` are instruction items (§4.2), read as text; listed here for ownership only. */
export const INSTRUCTION_ITEMS_FOLDER = 'instructions' as const;
