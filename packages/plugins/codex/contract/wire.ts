/**
 * Codex's wire schemas, copied from today's `@ferretry/protocol` `harness-update.ts` (the install/update view) with the
 * helper functions left to the port's `daemon/lib`. Strict objects; the only wire change is the harness key
 * (`codex`, the plugin id) and one view per harness. Codex has no native installer, so that install method is not in
 * this union. The permission-prompt and harness-dialog answers (G31, G32) are declared by Claude Code, which owns
 * them, and serve either harness.
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';

// ─── the program itself (GET/POST /v1/codex/update) ────────────────────────────────────────────────────────

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
export const VersionSchema = z.string().regex(VERSION_PATTERN);

/** One command or manual step, as a person reads it (today's `UpdateStepSchema`). */
export const UpdateStepSchema = z.strictObject({ command: z.string().min(1), note: z.string().min(1).optional() });

export const LatestReleaseSchema = z.strictObject({
  version: VersionSchema,
  url: z.url(),
  publishedAt: InstantSchema.optional(),
});

export const UpdateCheckSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('never') }),
  z.strictObject({ state: z.literal('ok'), checkedAt: InstantSchema, latest: LatestReleaseSchema }),
  z.strictObject({
    state: z.literal('failed'),
    checkedAt: InstantSchema,
    reason: z.string().min(1),
    lastKnown: z.strictObject({ checkedAt: InstantSchema, latest: LatestReleaseSchema }).optional(),
  }),
]);

export const HarnessVerificationSchema = z.enum(['verified', 'older', 'unverified', 'unknown']);
export type HarnessVerification = z.infer<typeof HarnessVerificationSchema>;

export const NodePackageToolSchema = z.enum(['npm', 'pnpm', 'bun', 'volta']);
export const NodeVersionManagerSchema = z.enum(['nvm', 'fnm', 'asdf', 'mise']);
const NixModuleManagerSchema = z.enum(['home-manager', 'nix-darwin', 'nixos']);
const NixSystemManagerSchema = z.enum(['nix-darwin', 'nixos']);

export const HarnessInstallMethodSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('npm-global'),
    tool: NodePackageToolSchema,
    package: z.string().min(1),
    prefix: z.string().min(1).optional(),
    nodeManager: NodeVersionManagerSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('homebrew'), type: z.enum(['cask', 'formula']), package: z.string().min(1) }),
  z.strictObject({ kind: z.literal('nix-profile'), element: z.string().min(1) }),
  z.strictObject({ kind: z.literal('nix-shell'), storePath: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('nix-module'),
    manager: NixModuleManagerSchema,
    via: NixSystemManagerSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('standalone'), directory: z.string().min(1) }),
  z.strictObject({ kind: z.literal('unknown'), reason: z.string().min(1) }),
]);
export type HarnessInstallMethod = z.infer<typeof HarnessInstallMethodSchema>;

export const HarnessUpdatePlanSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('self'),
    steps: z.array(UpdateStepSchema).min(1),
    rollback: z.enum(['automatic', 'none']),
    pinsVersion: z.boolean(),
  }),
  z.strictObject({ kind: z.literal('manual'), explanation: z.string().min(1), steps: z.array(UpdateStepSchema) }),
]);

export const HarnessCliLocationSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('located'),
    path: z.string().min(1),
    rule: z.string().min(1),
    declaredBy: z.string().min(1),
  }),
  z.strictObject({
    state: z.literal('override-absent'),
    path: z.string().min(1),
    declaredBy: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.strictObject({ state: z.literal('absent'), searched: z.array(z.string()) }),
]);
export type HarnessCliLocation = z.infer<typeof HarnessCliLocationSchema>;

export const HarnessInstalledVersionSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('ok'), version: VersionSchema }),
  z.strictObject({ state: z.literal('unreadable'), reason: z.string().min(1) }),
]);

export const HarnessUpdateOutcomeSchema = z.enum(['succeeded', 'unchanged', 'rolled-back', 'failed']);

export const HarnessUpdateReportSchema = z.strictObject({
  from: VersionSchema.optional(),
  to: VersionSchema.optional(),
  target: VersionSchema.optional(),
  outcome: HarnessUpdateOutcomeSchema,
  message: z.string().min(1),
  finishedAt: InstantSchema,
});

export const HarnessUpdateJobSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('running'),
    target: VersionSchema.optional(),
    startedAt: InstantSchema,
    command: z.string().min(1),
  }),
  z.strictObject({ state: z.literal('finished'), report: HarnessUpdateReportSchema }),
]);

/** `GET /v1/codex/update`: one harness (today's view held both harnesses in a list). */
export const HarnessCliViewSchema = z.strictObject({
  harness: HarnessKeySchema,
  location: HarnessCliLocationSchema,
  installed: HarnessInstalledVersionSchema.nullable(),
  method: HarnessInstallMethodSchema.nullable(),
  plan: HarnessUpdatePlanSchema.nullable(),
  check: UpdateCheckSchema,
  verified: z.strictObject({ version: VersionSchema, url: z.url() }),
  verification: HarnessVerificationSchema,
  available: z.boolean(),
  job: HarnessUpdateJobSchema.nullable(),
});
export type HarnessCliView = z.infer<typeof HarnessCliViewSchema>;

/** `POST /v1/codex/update`. The harness is the path, so the body names only the version. */
export const HarnessUpdateStartRequestSchema = z.strictObject({
  target: VersionSchema.optional(),
  /** The person's explicit yes to going past the version Ferretry verified. */
  confirmUnverified: z.boolean().optional(),
});
export type HarnessUpdateStartRequest = z.infer<typeof HarnessUpdateStartRequestSchema>;

export const HARNESS_UPDATE_CODES = {
  unverified: 'harness_update_unverified',
  inProgress: 'harness_update_in_progress',
  notLocated: 'harness_update_not_located',
  notSelfUpdatable: 'harness_update_not_self_updatable',
  notTargetable: 'harness_update_not_targetable',
  notAvailable: 'harness_update_not_available',
} as const;

/** The `409 harness_update_unverified` body: what would be installed, and what Ferretry verified. */
export const HarnessUpdateUnverifiedBodySchema = z.looseObject({
  error: z.string(),
  code: z.literal(HARNESS_UPDATE_CODES.unverified),
  target: VersionSchema.optional(),
  verified: VersionSchema,
});

// ─── config (config/harness-codex.yaml, codex/settings/*.yaml, codex/hooks/*.yaml) ──────────────

/** How the fixed layer sets the harness's permission mode: `auto` asks before anything risky, `skip` never asks. */
export const PermissionModeSchema = z.enum(['auto', 'skip']);

/** A path an operator writes: absolute or `~`-relative (docs/harness-paths.md). Never a credential. */
const HarnessPathSchema = z
  .string()
  .min(1)
  .refine(path => path.startsWith('/') || path.startsWith('~'), {
    message: 'a path is absolute or written against ~',
  });

export const HarnessConfigSchema = z.strictObject({
  /** The exact file to run; absent means "search for it". */
  binary: HarnessPathSchema.optional(),
  /** Directories to look in, in order, on top of what the daemon inherited. */
  searchPaths: z.array(HarnessPathSchema).default([]),
  permissionMode: PermissionModeSchema.default('auto'),
});
export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

/** A settings component: the harness's own settings document, as data. Values never hold a raw secret (`${secret:NAME}` only). */
export const SettingsItemSchema = z.strictObject({
  description: z.string().optional(),
  settings: z.record(z.string(), z.unknown()),
});
export type SettingsItem = z.infer<typeof SettingsItemSchema>;

// ─── state (state/codex/discovery.json) ────────────────────────────────────────────────────────────────────

/** What discovery last found. Never reads the harness's sign-in files. */
export const DiscoverySchema = z.strictObject({
  format: z.literal(1),
  checkedAt: InstantSchema,
  location: HarnessCliLocationSchema,
  installed: HarnessInstalledVersionSchema.nullable(),
  method: HarnessInstallMethodSchema.nullable(),
});
export type Discovery = z.infer<typeof DiscoverySchema>;
