/**
 * Claude Code's wire schemas, copied from today's `@ferretry/protocol` (`session-permission.ts`,
 * `session-dialog.ts`, `harness-update.ts`) with the helper functions left to the port's `daemon/lib`. Strict objects
 * throughout; the only wire change is the harness key (`claude` → `claude-code`, the plugin id).
 */
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { HarnessKeySchema } from './core.ts';

// ─── permission prompt (POST /v1/ferrets/:ferretId/permission) ───────────────────────────────────────────────────

export const PermissionOptionKindSchema = z.enum(['allow', 'allow-always', 'deny']);
export type PermissionOptionKind = z.infer<typeof PermissionOptionKindSchema>;

export const PermissionOptionSchema = z.strictObject({
  /** The digit the harness drew beside it, and the key that picks it. */
  number: z.number().int().min(1).max(9),
  /** The choice in the harness's own words, without its keyboard hint. */
  label: z.string().min(1).max(300),
  kind: PermissionOptionKindSchema,
});
export type PermissionOption = z.infer<typeof PermissionOptionSchema>;

export const PermissionActionSchema = z.enum(['run', 'read', 'edit', 'create', 'fetch', 'use', 'exit-plan', 'other']);
export type PermissionAction = z.infer<typeof PermissionActionSchema>;

/** A digest of everything a person decides on, so a changed prompt is a new id. */
export const PermissionRequestIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);

export const PermissionRequestSchema = z
  .strictObject({
    id: PermissionRequestIdSchema,
    harness: HarnessKeySchema,
    tool: z.string().min(1).max(120),
    action: PermissionActionSchema,
    what: z.string().min(1).max(500).optional(),
    detail: z.string().min(1).max(300).optional(),
    question: z.string().min(1).max(300),
    options: z.array(PermissionOptionSchema).min(2).max(9),
    /** The `number` of the option the harness's cursor is on. */
    selected: z.number().int().min(1).max(9),
  })
  .refine(request => request.options.every((option, index) => option.number === index + 1), {
    message: 'options are numbered 1..n in order',
  })
  .refine(request => request.selected <= request.options.length, { message: 'the selection is one of the options' });
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const PermissionAnswerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choice'),
    requestId: PermissionRequestIdSchema,
    number: z.number().int().min(1).max(9),
  }),
  z.strictObject({ kind: z.literal('deny'), requestId: PermissionRequestIdSchema }),
]);
export type PermissionAnswerRequest = z.infer<typeof PermissionAnswerRequestSchema>;

/** `cleared` is the pane's own word, read after the keys landed. It never carries the choice (G31). */
export const PermissionAnswerResultSchema = z.strictObject({
  requestId: PermissionRequestIdSchema,
  cleared: z.boolean(),
});
export type PermissionAnswerResult = z.infer<typeof PermissionAnswerResultSchema>;

// ─── harness dialog (POST /v1/ferrets/:ferretId/dialog) ──────────────────────────────────────────────────────────

export const HarnessDialogKindSchema = z.enum([
  'hooks-review',
  'hooks-list',
  'update',
  'sign-in',
  'mcp-servers',
  'settings-error',
  'directory-trust',
  'usage-limit',
  'other',
]);
export type HarnessDialogKind = z.infer<typeof HarnessDialogKindSchema>;

export const HarnessDialogOptionSchema = z.strictObject({
  number: z.number().int().min(1).max(9),
  label: z.string().min(1).max(300),
  detail: z.string().min(1).max(300).optional(),
  /** Choosing it trusts something to run. Never chosen by the daemon. */
  grantsTrust: z.boolean(),
});
export type HarnessDialogOption = z.infer<typeof HarnessDialogOptionSchema>;

export const HarnessDialogIdSchema = z.string().regex(/^[0-9a-f]{16}$/u);

export const HarnessDialogSchema = z
  .strictObject({
    id: HarnessDialogIdSchema,
    harness: HarnessKeySchema,
    kind: HarnessDialogKindSchema,
    title: z.string().min(1).max(300),
    body: z.string().min(1).max(1200).optional(),
    options: z.array(HarnessDialogOptionSchema).max(9),
    selected: z.number().int().min(1).max(9).optional(),
    escape: z.string().min(1).max(60).optional(),
  })
  .refine(dialog => dialog.options.every((option, index) => option.number === index + 1), {
    message: 'options are numbered 1..n in order',
  })
  .refine(dialog => (dialog.selected === undefined) === (dialog.options.length === 0), {
    message: 'a dialog with options has a selection, and only then',
  })
  .refine(dialog => dialog.selected === undefined || dialog.selected <= dialog.options.length, {
    message: 'the selection is one of the options',
  })
  .refine(dialog => dialog.options.length > 0 || dialog.escape !== undefined, {
    message: 'a dialog offers a way out: an option or Esc',
  });
export type HarnessDialog = z.infer<typeof HarnessDialogSchema>;

export const HarnessDialogAnswerRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('choice'),
    dialogId: HarnessDialogIdSchema,
    number: z.number().int().min(1).max(9),
  }),
  z.strictObject({ kind: z.literal('escape'), dialogId: HarnessDialogIdSchema }),
]);
export type HarnessDialogAnswerRequest = z.infer<typeof HarnessDialogAnswerRequestSchema>;

/** Never carries the choice (G32). */
export const HarnessDialogAnswerResultSchema = z.strictObject({
  dialogId: HarnessDialogIdSchema,
  cleared: z.boolean(),
});
export type HarnessDialogAnswerResult = z.infer<typeof HarnessDialogAnswerResultSchema>;

// ─── the program itself (GET/POST /v1/claude-code/update) ────────────────────────────────────────────────────────

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
  /** Claude Code's own installer (`claude install`). */
  z.strictObject({ kind: z.literal('native-installer'), directory: z.string().min(1) }),
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

/** `GET /v1/claude-code/update`: one harness (today's view held both harnesses in a list). */
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

/** `POST /v1/claude-code/update`. The harness is the path, so the body names only the version. */
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

// ─── config (config/harness-claude-code.yaml, claude-code/settings/*.yaml, claude-code/hooks/*.yaml) ──────────────

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

/** A hooks component: harness hooks keyed by event name. */
export const HooksItemSchema = z.strictObject({
  description: z.string().optional(),
  hooks: z.record(z.string(), z.array(z.unknown())),
});
export type HooksItem = z.infer<typeof HooksItemSchema>;

// ─── state (state/claude-code/discovery.json) ────────────────────────────────────────────────────────────────────

/** What discovery last found. Never reads the harness's sign-in files. */
export const DiscoverySchema = z.strictObject({
  format: z.literal(1),
  checkedAt: InstantSchema,
  location: HarnessCliLocationSchema,
  installed: HarnessInstalledVersionSchema.nullable(),
  method: HarnessInstallMethodSchema.nullable(),
});
export type Discovery = z.infer<typeof DiscoverySchema>;
