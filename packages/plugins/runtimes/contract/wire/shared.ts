/**
 * SHAPES THAT BELONG TO OTHER SUBSYSTEMS, HELD LOCALLY.
 *
 * Runtimes may import only Ferrets' contract (§2.4: no plugin→plugin edge but Packs → Runtimes and Usage → Logins), yet
 * today's catalogue and change documents embed pieces that other subsystems own: a login's view and store (Logins), the
 * browser settings (Browsers), a catalog install's provenance (Catalogs), the grant refusal vocabulary (Gate), the
 * auto-resume summary (Ferrets) and a secret name (Vault). Each is copied here as the SMALLEST local shape that keeps
 * today's wire, or loosened to a documented placeholder. Every placeholder is listed in the port's hand-over; when the
 * owner's contract lands, the port compares and (where §2.4 allows) swaps to its import.
 *
 * COPIED, not loosened: HarnessKey (Claude Code / Codex key), CredentialStore, CredentialStatusWord, Disabled,
 * GrantRefusal, BrowserMode, BrowserFirewallFailure, BrowserPortsSetting, AutoResumeSummary, LocalModels, SecretName.
 * PLACEHOLDER (looser than today): BrowserProxySetting, CatalogProvenance, CredentialView.
 */
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';

export { HarnessKeySchema, InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema };

// ─── Logins ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a login is kept. */
export const CredentialStoreSchema = z.enum(['host', 'ferretry', 'environment']);
export type CredentialStore = z.infer<typeof CredentialStoreSchema>;

export const CredentialStatusWordSchema = z.enum(['ready', 'refresh_due', 'needs_sign_in', 'checking']);
export type CredentialStatusWord = z.infer<typeof CredentialStatusWordSchema>;

/**
 * A login or runtime that is switched off (docs/disabling.md). `until` is the instant it switches itself back on;
 * `source` says which switch is holding a RUNTIME off. Shared with Logins' view of the same fact: Runtimes owns the
 * runtime half, so the schema lives in both contracts (neither imports the other).
 */
export const DisabledSchema = z.strictObject({
  reason: NonEmptyStringSchema.max(200).optional(),
  until: InstantSchema.optional(),
  source: z.enum(['login', 'runtime']),
});
export type Disabled = z.infer<typeof DisabledSchema>;

/**
 * PLACEHOLDER. Logins' `LoginView` (a login with its status, usage, budget and environment) is embedded by the
 * `signed-out` outcome of a change. Looser than today: any object, to be parsed by Logins' own schema at the edge.
 */
export const CredentialViewSchema = z.looseObject({ id: NonEmptyStringSchema });
export type CredentialView = z.infer<typeof CredentialViewSchema>;

/** One model a local server (Ollama) has installed. Logins owns model catalogs; the runtime view carries what was last read. */
export const LocalModelsSchema = z.strictObject({
  provider: z.literal('ollama'),
  baseUrl: NonEmptyStringSchema,
  state: z.enum(['found', 'none-pulled', 'not-running', 'unreadable', 'refused', 'disabled']),
  models: z
    .array(
      z.strictObject({
        id: NonEmptyStringSchema,
        label: NonEmptyStringSchema,
        sizeBytes: z.number().int().nonnegative().optional(),
        parameterSize: NonEmptyStringSchema.optional(),
        quantization: NonEmptyStringSchema.optional(),
        family: NonEmptyStringSchema.optional(),
        modifiedAt: InstantSchema.optional(),
      }),
    )
    .readonly(),
  checkedAt: InstantSchema,
  message: NonEmptyStringSchema,
  pullCommand: NonEmptyStringSchema,
});
export type LocalModels = z.infer<typeof LocalModelsSchema>;

// ─── Gate ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Why a caller may or may not do something, in the shared grant vocabulary. */
export const GrantRefusalSchema = z.enum([
  'granted',
  'not-granted',
  'device-not-granted',
  'step-up-required',
  'undetermined',
]);
export type GrantRefusal = z.infer<typeof GrantRefusalSchema>;

// ─── Browsers ────────────────────────────────────────────────────────────────────────────────────────────────────

export const BrowserModeSchema = z.enum(['headless', 'window']);
export const BrowserFirewallFailureSchema = z.enum(['warn', 'refuse']);

const PortSchema = z.number().int().min(1024).max(65535);
export const BrowserPortsSettingSchema = z.union([
  z.literal('random'),
  z.literal('per-user'),
  z
    .strictObject({ cdp: PortSchema, relay: PortSchema, vnc: PortSchema })
    .refine(ports => new Set([ports.cdp, ports.relay, ports.vnc]).size === 3, {
      message: 'browserPorts needs three different ports for cdp, relay and vnc',
    }),
]);

/**
 * PLACEHOLDER (shape kept, address and bypass rules loosened). Today's schema also refuses a proxy address that is
 * not http/https/socks5 and checks each bypass entry; Browsers' contract owns those rules.
 */
export const BrowserProxySettingSchema = z.strictObject({
  url: z.string().trim().min(1).max(512),
  bypass: z.array(z.string().trim().min(1).max(253)).max(64).default([]),
  /** A `${secret:NAME}` reference, never a value. */
  username: z.string().optional(),
  password: z.string().optional(),
});
export type BrowserProxySetting = z.infer<typeof BrowserProxySettingSchema>;

// ─── Ferrets ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the last "Auto-resume after restart" pass did. */
export const AutoResumeSummarySchema = z.strictObject({
  at: InstantSchema,
  resumed: NonNegativeIntegerSchema,
  skipped: z.array(z.strictObject({ sessionId: NonEmptyStringSchema, reason: NonEmptyStringSchema })).readonly(),
});
export type AutoResumeSummary = z.infer<typeof AutoResumeSummarySchema>;

// ─── Catalogs ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * PLACEHOLDER (field names kept, grammar loosened to non-empty strings). Where an install came from, as the daemon
 * VERIFIED it. Catalogs owns the real grammar (ids, labels, digest).
 */
export const CatalogProvenanceSchema = z.strictObject({
  publisher: NonEmptyStringSchema,
  publisherName: NonEmptyStringSchema,
  catalogId: NonEmptyStringSchema,
  catalogName: NonEmptyStringSchema,
  itemId: NonEmptyStringSchema,
  kind: NonEmptyStringSchema,
  name: NonEmptyStringSchema,
  version: z.number().int().min(1),
  digest: NonEmptyStringSchema,
});
export type CatalogProvenance = z.infer<typeof CatalogProvenanceSchema>;

// ─── Vault ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** The most secrets one daemon holds (Vault's limit; a copy lists at most this many). */
export const MAX_SECRETS_PER_DAEMON = 256;

/**
 * A secret NAME (never a value) a copy may carry. Placeholder for Vault's `CloneableSecretName`: same grammar
 * (uppercase letters, digits, underscores); Vault's extra rule that a sign-in's name is refused is applied by the half.
 */
export const CloneableSecretNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/u, 'a secret name is uppercase letters, digits and underscores');

/** The longest configuration document a copy carries (the config files' limit). */
export const CONFIG_FILE_MAX_BYTES = 256 * 1024;

/**
 * PLACEHOLDER (path rules loosened to length and no `..`). One file of a catalog skill, relative to the skill's own
 * folder. Catalogs owns the real rule (canonical relative path, depth, per-segment checks).
 */
export const CATALOG_SKILL_MAX_FILES = 200;
export const CatalogSkillFileSchema = z.strictObject({
  path: z
    .string()
    .max(512)
    .refine(path => !path.startsWith('/') && !path.split('/').includes('..'), 'a plain relative path inside the skill'),
  content: z.string().max(256 * 1024),
});
export type CatalogSkillFile = z.infer<typeof CatalogSkillFileSchema>;
