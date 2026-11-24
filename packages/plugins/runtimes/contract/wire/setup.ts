/**
 * The wire contract for a machine's setup (today's `fleet-setup.ts`, renamed): the first-run scan, installing a
 * harness tool, and the Clone export. The scan never carries a value; the export never carries a credential or history.
 * Every object is strict. The import itself and the clone are reviewed changes (`setup.import`, `clone.import`).
 */
import { z } from 'zod';
import { CatalogActSchema, CatalogFormatSchema } from './catalog.ts';
import {
  HarnessKeySchema,
  InstantSchema,
  MAX_HARNESSES,
  NonEmptyStringSchema,
  NonNegativeIntegerSchema,
} from './shared.ts';

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

/** How a missing tool would be installed: the exact command, or why it cannot be and what to run. */
export const ToolInstallPlanSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('runnable'), command: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('no-package-manager'),
    reason: NonEmptyStringSchema,
    manualCommand: NonEmptyStringSchema,
  }),
]);
export type ToolInstallPlan = z.infer<typeof ToolInstallPlanSchema>;

/** One harness tool on this machine: found, or the plan an install would follow. */
export const SetupToolSchema = z.discriminatedUnion('installed', [
  z.strictObject({
    harness: HarnessKeySchema,
    label: NonEmptyStringSchema,
    installed: z.literal(true),
  }),
  z.strictObject({
    harness: HarnessKeySchema,
    label: NonEmptyStringSchema,
    installed: z.literal(false),
    install: ToolInstallPlanSchema,
  }),
]);
export type SetupTool = z.infer<typeof SetupToolSchema>;

export const ToolInstallRequestSchema = z.strictObject({
  harnesses: z.array(HarnessKeySchema).min(1).max(MAX_HARNESSES),
  /**
   * The command the person was SHOWN for a harness before pressing Install. When it is there and the daemon's fresh plan
   * for that harness is a different command, the daemon refuses before starting anything (the machine changed between the
   * look and the press), so what runs is only ever what was on the screen. Absent: the daemon runs its own plan.
   */
  shown: z
    .array(z.strictObject({ harness: HarnessKeySchema, command: NonEmptyStringSchema }))
    .max(MAX_HARNESSES)
    .readonly()
    .optional(),
});
export type ToolInstallRequest = z.infer<typeof ToolInstallRequestSchema>;

/** How installing one tool ended (E1, E2). A failure always carries the command to run by hand. */
export const ToolInstallOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ harness: HarnessKeySchema, outcome: z.literal('already-installed') }),
  z.strictObject({
    harness: HarnessKeySchema,
    outcome: z.literal('installed'),
    command: NonEmptyStringSchema,
    // The manager's last lines, scrubbed daemon-side (no token, no credential line); bounded.
    output: z.array(z.string().max(200)).max(20).readonly().default([]),
  }),
  z.strictObject({
    harness: HarnessKeySchema,
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
    output: z.array(z.string().max(200)).max(20).readonly().default([]),
  }),
]);
export type ToolInstallOutcome = z.infer<typeof ToolInstallOutcomeSchema>;

export const ToolInstallResultSchema = z.strictObject({
  outcomes: z.array(ToolInstallOutcomeSchema).readonly(),
});
export type ToolInstallResult = z.infer<typeof ToolInstallResultSchema>;

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────────

/** The person's own login for one harness, as the scan classified it. Never the credential. */
export const HostLoginSchema = z.strictObject({
  state: z.enum(['signed-in', 'refresh-due', 'not-signed-in', 'unreadable', 'not-shareable', 'unknown']),
  email: NonEmptyStringSchema.optional(),
  reason: NonEmptyStringSchema.optional(),
});
export type HostLogin = z.infer<typeof HostLoginSchema>;

/** What the first run found for one harness (§4.3 steps 2 and 3). */
export const HarnessScanSchema = z.strictObject({
  harness: HarnessKeySchema,
  installed: z.boolean(),
  account: HostLoginSchema,
  instructions: z
    .strictObject({ name: NonEmptyStringSchema, source: NonEmptyStringSchema, bytes: NonNegativeIntegerSchema })
    .optional(),
  settings: z
    .strictObject({
      source: NonEmptyStringSchema,
      count: NonNegativeIntegerSchema,
      /** How many hooks the host has. Counted so the screen can say "found N, not imported": an import never takes them. */
      hooks: NonNegativeIntegerSchema,
    })
    .optional(),
  mcpServers: z.array(NonEmptyStringSchema).readonly(),
  skills: z.array(NonEmptyStringSchema).readonly(),
  /**
   * Folders whose own instructions file the host knows (Claude's `~/.claude.json` `projects`). They stay in
   * each project for agents to read there; this lists them, and nothing in them is read. `verified` is whether the
   * file was seen to exist: Runtimes may not look inside a project folder, so it is usually `false`.
   */
  projectInstructions: z
    .array(z.strictObject({ path: NonEmptyStringSchema, file: NonEmptyStringSchema, verified: z.boolean() }))
    .readonly()
    .optional(),
  /** Codex's `[profiles.*]`: names and the model and effort each sets, nothing else. */
  codexProfiles: z
    .array(
      z.strictObject({
        name: NonEmptyStringSchema,
        model: NonEmptyStringSchema.optional(),
        effort: NonEmptyStringSchema.optional(),
      }),
    )
    .readonly()
    .optional(),
  /** Secret-looking keys BY NAME (`env.ANTHROPIC_API_KEY`). Their values never leave the machine. */
  secretKeys: z.array(NonEmptyStringSchema).readonly(),
  missingCommands: z.array(NonEmptyStringSchema).readonly(),
  problems: z.array(NonEmptyStringSchema).readonly(),
});
export type HarnessScan = z.infer<typeof HarnessScanSchema>;

/** A runtime the import would create, under the name it suggests (§4.3 step 4). */
export const SetupRuntimeSchema = z.strictObject({
  harness: HarnessKeySchema,
  name: NonEmptyStringSchema,
  profile: NonEmptyStringSchema,
});

/** A component whose source changed since the last import: offered, never applied unless chosen (O6). */
export const SetupUpdateSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  sources: z.array(NonEmptyStringSchema).readonly(),
});

/** A runtime the import did not create because one already uses that login and profile (E15). */
export const SetupDuplicateSchema = z.strictObject({
  harness: HarnessKeySchema,
  existing: NonEmptyStringSchema,
  suggested: NonEmptyStringSchema,
});

export const SetupScanSchema = z.strictObject({
  machine: NonEmptyStringSchema,
  format: CatalogFormatSchema,
  tools: z.array(SetupToolSchema).readonly(),
  harnesses: z.array(HarnessScanSchema).readonly(),
  /** Whether `CLAUDE.md` and `AGENTS.md` say the same thing; absent unless both were found (E9). */
  instructionsIdentical: z.boolean().optional(),
  /** Every harness that would be imported, with the runtime it would create. */
  runtimes: z.array(SetupRuntimeSchema).readonly(),
  /** Import again only. */
  updates: z.array(SetupUpdateSchema).readonly(),
  duplicates: z.array(SetupDuplicateSchema).readonly(),
  /** The result screen's sentences (E4–E9). */
  notes: z.array(z.strictObject({ harness: HarnessKeySchema, text: NonEmptyStringSchema })).readonly(),
  /** Whether an import may be staged now, and why not when it may not. */
  importing: CatalogActSchema,
});
export type SetupScan = z.infer<typeof SetupScanSchema>;

// ── Clone ────────────────────────────────────────────────────────────────────────────────────────

/** The bundle's format marker, so a file that is not one is refused by name. */
export const CLONE_BUNDLE_FORMAT = 'ferretry-clone';

/**
 * A login the source runtimes use, as a descriptor (L2). A signed-in login becomes an empty slot on the
 * target. An ENVIRONMENT login (docs/provider-presets.md) travels as what its file holds — plain values,
 * secret NAMES as `${secret:NAME}`, its cloud credential REFERENCE and its Codex provider — and never a
 * secret value, which no file may hold; the target is told which secrets and references it needs.
 */
export const CloneCredentialSchema = z.strictObject({
  id: NonEmptyStringSchema,
  harness: HarnessKeySchema,
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
export type CloneCredential = z.infer<typeof CloneCredentialSchema>;

/** One component document, relative to the fleet's asset tree, carried as text. */
export const CloneFileSchema = z.strictObject({
  path: NonEmptyStringSchema,
  content: z.string(),
});
export type CloneFile = z.infer<typeof CloneFileSchema>;

/**
 * An item's ORIGIN KEY (docs/design/account-model.md §3.8): 16 random bytes in lower-case base32
 * (26 characters), minted once by the source and stable across renames, so a later copy can tell a
 * renamed item from a new one. It is random on purpose — nothing about the item can be read from it.
 */
export const ORIGIN_KEY_PATTERN = /^[a-z2-7]{26}$/u;
export const OriginKeySchema = z.string().regex(ORIGIN_KEY_PATTERN, 'an origin key is 16 random bytes in base32');
export type OriginKey = z.infer<typeof OriginKeySchema>;

/** How many keys one bundle may carry. A source with more items refuses to export rather than send keys it cannot hold. */
export const CLONE_BUNDLE_KEYS_LIMIT = 8192;

/** A key's subject: `<kind>/<name>`, `profile/<name>`, `runtime/<name>` or `login/<id>`. */
export const CloneKeyReferenceSchema = z.string().regex(/^[a-zA-Z]+\/.+$/u, 'a key names <kind>/<name>');

/**
 * Everything Clone copies: components, model sets, profiles and runtimes, plus the documents the components name. The
 * component, profile and runtime entries are the configuration's own shapes, checked again when the target plans the
 * copy. `daemon` is the source's self-reported id and `keys` maps every copied item to its origin key; nothing in
 * either is secret (the keys are random, and a target computes every digest itself). One format: `version: 1`.
 */
export const CloneBundleSchema = z.strictObject({
  format: z.literal(CLONE_BUNDLE_FORMAT),
  version: z.literal(1),
  machine: NonEmptyStringSchema,
  daemon: NonEmptyStringSchema,
  exportedAt: InstantSchema,
  credentials: z.array(CloneCredentialSchema).readonly(),
  components: z.record(z.string(), z.record(z.string(), z.unknown())),
  profiles: z.record(z.string(), z.unknown()),
  runtimes: z.record(z.string(), z.unknown()),
  files: z.array(CloneFileSchema).readonly(),
  /** Documents the source could not carry, each with the reason (too large, outside the asset tree). */
  notCopied: z.array(z.strictObject({ path: NonEmptyStringSchema, reason: NonEmptyStringSchema })).readonly(),
  keys: z
    .record(CloneKeyReferenceSchema, OriginKeySchema)
    .refine(keys => Object.keys(keys).length <= CLONE_BUNDLE_KEYS_LIMIT, {
      message: `a bundle carries at most ${String(CLONE_BUNDLE_KEYS_LIMIT)} keys`,
    }),
});
export type CloneBundle = z.infer<typeof CloneBundleSchema>;

/** Every refusal the setup surface answers with, so a client branches on cause. */
export const SETUP_REFUSAL_CODES = [
  'fleet_setup_unreadable',
  'fleet_setup_refused',
  'fleet_setup_unauthorized',
  'fleet_setup_busy',
] as const;
export const SetupRefusalCodeSchema = z.enum(SETUP_REFUSAL_CODES);
export type SetupRefusalCode = z.infer<typeof SetupRefusalCodeSchema>;
