import { defineConfig, defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { FerretIdSchema, FerretRecordSchema } from './ids.ts';

/** Ferrets' declared files (§9.2). Every JSON document has `format: 1` first. */

export const FerretFiles = defineState({
  name: 'ferret',
  path: '*/ferret.json',
  store: 'json',
  format: 1,
  schema: FerretRecordSchema,
});
export const FerretHistoryFiles = defineState({ name: 'history', path: '*/history.jsonl', store: 'jsonl', format: 1 });

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
export const NamesFile = defineState({ name: 'names', path: 'names.json', store: 'json', format: 1 });
export const ArchiveFile = defineState({ name: 'archive', path: 'archive.json', store: 'json', format: 1 });
export const AutoResumeFile = defineState({ name: 'auto-resume', path: 'auto-resume.json', store: 'json', format: 1 });
export const RestartsFile = defineState({ name: 'restarts', path: 'restarts.json', store: 'json', format: 1 });
export const WorktreesFile = defineState({ name: 'worktrees', path: 'worktrees.json', store: 'json', format: 1 });
export const ForkFiles = defineState({ name: 'forks', path: 'forks/*.json', store: 'json', format: 1 });
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

const sizeBytes = (value: unknown): number => {
  const parsed = parseLimitSize(value);
  if (parsed === undefined || parsed.kind === 'unlimited') return Number.POSITIVE_INFINITY;
  return parsed.kind === 'bytes' ? parsed.bytes : parsed.percent * 1e12; // percent and bytes compared within kind only
};
const raised = (before: unknown, after: unknown): boolean =>
  after !== undefined && (before === undefined ? true : sizeBytes(after) > sizeBytes(before));

/**
 * Which `limits.yaml` edits loosen (docs/ferret-limits.md: raising a cap is held for the owner): turning limits off,
 * raising any memory, swap, task or CPU cap, or dropping the disk priority.
 */
export function limitsLoosen(before: LimitsFile | undefined, after: LimitsFile): readonly string[] {
  const from = before ?? {};
  const loosened: string[] = [];
  if (from.enabled !== false && after.enabled === false) loosened.push('limits turned off');
  if (from.ionice !== false && after.ionice === false) loosened.push('ferret disk priority no longer lowered');
  for (const scope of ['fleet', 'perFerret'] as const)
    for (const key of ['memoryHigh', 'memoryMax', 'swapMax', 'tasksMax', 'cpuPercent'] as const) {
      const was = (from[scope] as Record<string, unknown> | undefined)?.[key];
      const now = (after[scope] as Record<string, unknown> | undefined)?.[key];
      if (now !== undefined && was !== undefined && raised(was, now)) loosened.push(`${scope}.${key} raised`);
      if (was !== undefined && now === undefined) loosened.push(`${scope}.${key} removed`);
    }
  return loosened;
}

export const LimitsConfigFile = defineConfig({
  file: 'limits.yaml',
  schema: LimitsFileSchema,
  axis: 'configure',
  loosens: limitsLoosen,
});

/** `config/instructions/<name>.md` are instruction items (§4.2), read as text; listed here for ownership only. */
export const INSTRUCTION_ITEMS_FOLDER = 'instructions' as const;
