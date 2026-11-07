import type { FerretId } from '@ferretry/kernel/contract';
import { type Brand, InstantSchema, KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';

/**
 * Ferret identity (§2.2): ids, names, parent/child, packs, the state machine. `FerretId` is the kernel's (it only
 * carries it); Ferrets mints it. Today's session id shape, unchanged.
 */
export type { FerretId };

export const FerretIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, 'a ferret id is letters, digits, - and _')
  .transform(value => value as FerretId);

/** A ferret's name as the owner reads it (`:name` references it). */
export const FerretNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/u, 'a ferret name is letters, digits, spaces, . - and _');

export type PackId = Brand<string, 'PackId'>;
export const PackIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u)
  .transform(value => value as PackId);

/** A harness key under `harnesses`: `claude-code`, `codex`. */
export const HARNESS_KEYS = ['claude-code', 'codex'] as const;
export const HarnessKeySchema = z.enum(HARNESS_KEYS);
export type HarnessKey = z.infer<typeof HarnessKeySchema>;

/** A runner key under `runners`: `tmux`. */
export const RUNNER_KEYS = ['tmux'] as const;
export const RunnerKeySchema = z.enum(RUNNER_KEYS);
export type RunnerKey = z.infer<typeof RunnerKeySchema>;

/** A login kind key under `logins` (§4.4). */
export const LOGIN_KIND_KEYS = ['anthropic', 'openai', 'api-key', 'proxy', 'endpoint'] as const;
export const LoginKindKeySchema = z.enum(LOGIN_KIND_KEYS);
export type LoginKindKey = z.infer<typeof LoginKindKeySchema>;

/** A configured login's name (`config/logins/<name>.yaml`); Logins owns the files, this is only the name. */
export const LoginNameSchema = z.string().regex(KEBAB_NAME).max(40);
/** A runtime's name (`config/runtimes/<name>.yaml`). */
export const RuntimeNameSchema = z.string().regex(KEBAB_NAME).max(40);

/** The four states (§1 word table): starting, working, idle, stopped. A stopped ferret can resume. */
export const FERRET_STATES = ['starting', 'working', 'idle', 'stopped'] as const;
export const FerretStateSchema = z.enum(FERRET_STATES);
export type FerretState = z.infer<typeof FerretStateSchema>;

/** A lead started it, or its parent did (a helper); the owner's ferrets have no parent. */
export const FerretRoleSchema = z.enum(['lead', 'helper']);
export type FerretRole = z.infer<typeof FerretRoleSchema>;

/** `state/ferrets/<ferret>/ferret.json`: who a ferret is. Turn, usage and transcript facts are other owners'. */
export const FerretRecordSchema = z.strictObject({
  format: z.literal(1),
  id: FerretIdSchema,
  name: FerretNameSchema,
  parent: FerretIdSchema.optional(),
  pack: PackIdSchema.optional(),
  role: FerretRoleSchema,
  harness: HarnessKeySchema,
  runner: RunnerKeySchema,
  runtime: RuntimeNameSchema.optional(),
  login: LoginNameSchema.optional(),
  /** The folder it was started in: the one `WorkFolders` lets it work in. */
  folder: z.string().min(1).max(4_096),
  state: FerretStateSchema,
  /** The harness's own conversation id, for `resume`. */
  harnessConversation: z.string().min(1).max(256).optional(),
  /** The runner's handle while it runs (Terminals: the tmux pane id), for `attach` (spine D15). */
  handle: z.string().min(1).max(256).optional(),
  createdAt: InstantSchema,
  stateAt: InstantSchema,
});
export type FerretRecord = z.infer<typeof FerretRecordSchema>;

/** What other subsystems and the app read about a ferret. */
export const FerretSummarySchema = FerretRecordSchema.omit({ format: true, handle: true });
export type FerretSummary = z.infer<typeof FerretSummarySchema>;
