/**
 * The wire contract for a machine's setup (docs/design/account-model.md §4.3, §4.7, §7): the
 * first-run scan, installing a harness tool, and the Clone export.
 *
 * - `GET /v1/fleet/setup/scan` — what the first run (and Import again) would find: each tool, each
 *   harness's login state, instructions, settings, MCP servers and skills, the secret-looking keys BY
 *   NAME, missing commands, the runtime names it would suggest, and what Import again would offer to
 *   update. Never a value.
 * - `POST /v1/fleet/machine/tools/install` — install named harness tools with the exact command the
 *   scan showed. From off the machine it needs the passkey step-up.
 * - `GET /v1/fleet/export` — the Clone bundle: components, model sets, profiles and runtimes, and each
 *   login the runtimes use as a DESCRIPTOR (harness, label, email). No credential and no history.
 *
 * The import itself and the clone are reviewed changes (`setup.import`, `clone.import` in
 * `fleet-catalog.ts`): staged, previewed and applied like every other change to a machine.
 *
 * Every object is strict, so a field the daemon grew without adding it here fails the response.
 */
import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';
import { FleetCatalogActSchema, FleetCatalogFormatSchema } from './fleet-catalog.ts';

const HarnessKindSchema = z.enum(['claude', 'codex']);

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

/** How a missing tool would be installed: the exact command, or why it cannot be and what to run. */
export const FleetToolInstallPlanSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('runnable'), command: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('no-package-manager'),
    reason: NonEmptyStringSchema,
    manualCommand: NonEmptyStringSchema,
  }),
]);
export type FleetToolInstallPlan = z.infer<typeof FleetToolInstallPlanSchema>;

/** One harness tool on this machine: found, or the plan an install would follow. */
export const FleetSetupToolSchema = z.discriminatedUnion('installed', [
  z.strictObject({
    harness: HarnessKindSchema,
    label: NonEmptyStringSchema,
    installed: z.literal(true),
  }),
  z.strictObject({
    harness: HarnessKindSchema,
    label: NonEmptyStringSchema,
    installed: z.literal(false),
    install: FleetToolInstallPlanSchema,
  }),
]);
export type FleetSetupTool = z.infer<typeof FleetSetupToolSchema>;

export const FleetToolInstallRequestSchema = z.strictObject({
  harnesses: z.array(HarnessKindSchema).min(1).max(2),
});
export type FleetToolInstallRequest = z.infer<typeof FleetToolInstallRequestSchema>;

/** How installing one tool ended (E1, E2). A failure always carries the command to run by hand. */
export const FleetToolInstallOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ harness: HarnessKindSchema, outcome: z.literal('already-installed') }),
  z.strictObject({ harness: HarnessKindSchema, outcome: z.literal('installed'), command: NonEmptyStringSchema }),
  z.strictObject({
    harness: HarnessKindSchema,
    outcome: z.literal('failed'),
    cause: z.enum([
      'no-package-manager',
      'needs-admin',
      'timed-out',
      'could-not-start',
      'failed',
      'not-found-after-install',
    ]),
    reason: NonEmptyStringSchema,
    manualCommand: NonEmptyStringSchema,
  }),
]);
export type FleetToolInstallOutcome = z.infer<typeof FleetToolInstallOutcomeSchema>;

export const FleetToolInstallResultSchema = z.strictObject({
  outcomes: z.array(FleetToolInstallOutcomeSchema).readonly(),
});
export type FleetToolInstallResult = z.infer<typeof FleetToolInstallResultSchema>;

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────────

/** The person's own login for one harness, as the scan classified it. Never the credential. */
export const FleetHostLoginSchema = z.strictObject({
  state: z.enum(['signed-in', 'refresh-due', 'not-signed-in', 'unreadable', 'not-shareable']),
  email: NonEmptyStringSchema.optional(),
  reason: NonEmptyStringSchema.optional(),
});
export type FleetHostLogin = z.infer<typeof FleetHostLoginSchema>;

/** What the first run found for one harness (§4.3 steps 2 and 3). */
export const FleetHarnessScanSchema = z.strictObject({
  harness: HarnessKindSchema,
  installed: z.boolean(),
  account: FleetHostLoginSchema,
  instructions: z
    .strictObject({ name: NonEmptyStringSchema, source: NonEmptyStringSchema, bytes: NonNegativeIntegerSchema })
    .optional(),
  settings: z
    .strictObject({
      source: NonEmptyStringSchema,
      count: NonNegativeIntegerSchema,
      hooks: NonNegativeIntegerSchema,
    })
    .optional(),
  mcpServers: z.array(NonEmptyStringSchema).readonly(),
  skills: z.array(NonEmptyStringSchema).readonly(),
  /** Secret-looking keys BY NAME (`env.ANTHROPIC_API_KEY`). Their values never leave the machine. */
  secretKeys: z.array(NonEmptyStringSchema).readonly(),
  missingCommands: z.array(NonEmptyStringSchema).readonly(),
  problems: z.array(NonEmptyStringSchema).readonly(),
});
export type FleetHarnessScan = z.infer<typeof FleetHarnessScanSchema>;

/** A runtime the import would create, under the name it suggests (§4.3 step 4). */
export const FleetSetupRuntimeSchema = z.strictObject({
  harness: HarnessKindSchema,
  name: NonEmptyStringSchema,
  profile: NonEmptyStringSchema,
});

/** A component whose source changed since the last import: offered, never applied unless chosen (O6). */
export const FleetSetupUpdateSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  sources: z.array(NonEmptyStringSchema).readonly(),
});

/** A runtime the import did not create because one already uses that login and profile (E15). */
export const FleetSetupDuplicateSchema = z.strictObject({
  harness: HarnessKindSchema,
  existing: NonEmptyStringSchema,
  suggested: NonEmptyStringSchema,
});

export const FleetSetupScanSchema = z.strictObject({
  machine: NonEmptyStringSchema,
  format: FleetCatalogFormatSchema,
  tools: z.array(FleetSetupToolSchema).readonly(),
  harnesses: z.array(FleetHarnessScanSchema).readonly(),
  /** Whether `CLAUDE.md` and `AGENTS.md` say the same thing; absent unless both were found (E9). */
  instructionsIdentical: z.boolean().optional(),
  /** Every harness that would be imported, with the runtime it would create. */
  runtimes: z.array(FleetSetupRuntimeSchema).readonly(),
  /** Import again only. */
  updates: z.array(FleetSetupUpdateSchema).readonly(),
  duplicates: z.array(FleetSetupDuplicateSchema).readonly(),
  /** The result screen's sentences (E4–E9). */
  notes: z.array(z.strictObject({ harness: HarnessKindSchema, text: NonEmptyStringSchema })).readonly(),
  /** Whether an import may be staged now, and why not when it may not. */
  importing: FleetCatalogActSchema,
});
export type FleetSetupScan = z.infer<typeof FleetSetupScanSchema>;

// ── Clone ────────────────────────────────────────────────────────────────────────────────────────

/** The bundle's format marker, so a file that is not one is refused by name. */
export const FLEET_CLONE_BUNDLE_FORMAT = 'ferretry-clone';

/**
 * A login the source runtimes use, as a descriptor (L2). A signed-in login becomes an empty slot on the
 * target. An ENVIRONMENT login (docs/provider-presets.md) travels as what its file holds — plain values,
 * secret NAMES as `${secret:NAME}`, its cloud credential REFERENCE and its Codex provider — and never a
 * secret value, which no file may hold; the target is told which secrets and references it needs.
 */
export const FleetCloneCredentialSchema = z.strictObject({
  id: NonEmptyStringSchema,
  harness: HarnessKindSchema,
  label: NonEmptyStringSchema.optional(),
  email: NonEmptyStringSchema.optional(),
  store: z.literal('environment').optional(),
  env: z.record(z.string(), z.string()).optional(),
  preset: NonEmptyStringSchema.optional(),
  cloudCredential: NonEmptyStringSchema.optional(),
  codexProvider: z.record(z.string(), z.unknown()).optional(),
  /** An environment login that drives both CLIs: what each is given (docs/provider-presets.md). */
  claude: z.record(z.string(), z.unknown()).optional(),
  codex: z.record(z.string(), z.unknown()).optional(),
});
export type FleetCloneCredential = z.infer<typeof FleetCloneCredentialSchema>;

/** One component document, relative to the fleet's asset tree, carried as text. */
export const FleetCloneFileSchema = z.strictObject({
  path: NonEmptyStringSchema,
  content: z.string(),
});
export type FleetCloneFile = z.infer<typeof FleetCloneFileSchema>;

/**
 * Everything Clone copies (L1): components, model sets, profiles and runtimes, plus the documents
 * the components name. The component, profile and runtime entries are the configuration's own
 * shapes, checked again when the target plans the copy.
 */
export const FleetCloneBundleSchema = z.strictObject({
  format: z.literal(FLEET_CLONE_BUNDLE_FORMAT),
  version: z.literal(1),
  machine: NonEmptyStringSchema,
  exportedAt: InstantSchema,
  credentials: z.array(FleetCloneCredentialSchema).readonly(),
  components: z.record(z.string(), z.record(z.string(), z.unknown())),
  profiles: z.record(z.string(), z.unknown()),
  runtimes: z.record(z.string(), z.unknown()),
  files: z.array(FleetCloneFileSchema).readonly(),
  /** Documents the source could not carry, each with the reason (too large, outside the asset tree). */
  notCopied: z.array(z.strictObject({ path: NonEmptyStringSchema, reason: NonEmptyStringSchema })).readonly(),
});
export type FleetCloneBundle = z.infer<typeof FleetCloneBundleSchema>;

/** Every refusal the setup surface answers with, so a client branches on cause. */
export const FLEET_SETUP_REFUSAL_CODES = [
  'fleet_setup_unreadable',
  'fleet_setup_refused',
  'fleet_setup_unauthorized',
  'fleet_setup_busy',
] as const;
export const FleetSetupRefusalCodeSchema = z.enum(FLEET_SETUP_REFUSAL_CODES);
export type FleetSetupRefusalCode = z.infer<typeof FleetSetupRefusalCodeSchema>;
