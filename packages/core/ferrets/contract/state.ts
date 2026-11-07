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
// ─── what agents may control (today's `machine.agentControl`, `fleet/src/lib/account/schema.ts`) ─────────────

/**
 * "What agents may control" (T, session-spec.html Settings): the things a person can switch off independently for
 * every ferret on this machine — terminals, browsers, the project files, this machine's configuration files
 * (`config.*`) and an agent's own page scripts (`browser.eval`). Never a security boundary against the operator's
 * own agents, only a kill switch for one kind of thing they do. The effective value: every switch stated.
 */
export const AgentControlSchema = z.strictObject({
  terminals: z.boolean(),
  browsers: z.boolean(),
  files: z.boolean(),
  /**
   * Whether an agent may read and edit this machine's configuration files through the `config.*`
   * tools (docs/config-files.md). OFF by default, unlike the three above: it is how an agent changes
   * what every other agent may do. Even on, an agent's edit that loosens spend or authority is held
   * until the owner confirms it — this switch is a kill switch, the confirmation is the guard.
   */
  ferretrySettings: z.boolean(),
  /**
   * Whether an agent may run its own JavaScript in a page it drives (`browser.eval`, in an isolated
   * world: docs/agent-tools.md). OFF by default, like Ferretry settings: a script can read what the
   * page holds — on the shared agent profile, sign-ins included. Turning it on is a loosening, so it
   * is held until the owner confirms it.
   */
  pageScripts: z.boolean(),
});
export type AgentControl = z.infer<typeof AgentControlSchema>;

/**
 * Today's defaults: terminals, browsers and files on, because the product starts open and the switch is the escape
 * hatch; Ferretry settings and page scripts off.
 */
export const DEFAULT_AGENT_CONTROL: AgentControl = Object.freeze({
  terminals: true,
  browsers: true,
  files: true,
  ferretrySettings: false,
  pageScripts: false,
});

/** Every switch an answer names: a ferret this daemon does not know may control nothing. */
export const NO_AGENT_CONTROL: AgentControl = Object.freeze({
  terminals: false,
  browsers: false,
  files: false,
  ferretrySettings: false,
  pageScripts: false,
});

/** The switches `limits.yaml` states; an unstated one keeps today's default. */
export const AgentControlOverridesSchema = AgentControlSchema.partial();

export const LimitsFileSchema = z.strictObject({
  enabled: z.boolean().optional(),
  fleet: FleetLimitsSchema.optional(),
  perFerret: FerretLimitsSchema.optional(),
  ionice: z.boolean().optional(),
  /** What every ferret on this machine may control; unstated switches keep {@link DEFAULT_AGENT_CONTROL}. */
  agentControl: AgentControlOverridesSchema.optional(),
});
export type LimitsFile = z.infer<typeof LimitsFileSchema>;

/** The switches in effect: today's defaults with what `limits.yaml` states over them. */
export function effectiveAgentControl(limits: LimitsFile | undefined): AgentControl {
  return { ...DEFAULT_AGENT_CONTROL, ...limits?.agentControl };
}

/** How a loosening names each switch (today's `AGENT_CONTROL_WORDS`). */
const AGENT_CONTROL_WORDS: Readonly<Record<keyof AgentControl, string>> = {
  terminals: 'terminals',
  browsers: 'browsers',
  files: 'project files',
  ferretrySettings: 'Ferretry settings',
  pageScripts: 'page scripts',
};

const sizeBytes = (value: unknown): number => {
  const parsed = parseLimitSize(value);
  if (parsed === undefined || parsed.kind === 'unlimited') return Number.POSITIVE_INFINITY;
  return parsed.kind === 'bytes' ? parsed.bytes : parsed.percent * 1e12; // percent and bytes compared within kind only
};
const raised = (before: unknown, after: unknown): boolean =>
  after !== undefined && (before === undefined ? true : sizeBytes(after) > sizeBytes(before));

/**
 * Which `limits.yaml` edits loosen (docs/ferret-limits.md: raising a cap is held for the owner): turning limits off,
 * raising any memory, swap, task or CPU cap, dropping the disk priority, or switching ON anything agents may control
 * (compared in effect, so removing a stated "off" whose default is on loosens too).
 */
export function limitsLoosen(before: LimitsFile | undefined, after: LimitsFile): readonly string[] {
  const from = before ?? {};
  const loosened: string[] = [];
  const controlWas = effectiveAgentControl(before);
  const controlNow = effectiveAgentControl(after);
  for (const kind of Object.keys(AGENT_CONTROL_WORDS) as (keyof AgentControl)[])
    if (!controlWas[kind] && controlNow[kind]) loosened.push(`agents may now control ${AGENT_CONTROL_WORDS[kind]}`);
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
