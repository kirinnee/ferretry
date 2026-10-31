/**
 * The wire contract for the account model's credentials (docs/design/account-model.md §3.2, §7):
 * `GET /v1/fleet/credentials` and the explicit `POST /v1/fleet/credentials/:id/check`.
 *
 * ## Status and usage, never material
 *
 * A row says whether a login works, how much of its two rate-limit windows is spent, which runtimes use
 * it and what signing it out would do. There is no field here that could carry an access token, a
 * refresh token or a digest of either: the daemon parses its own answers through these schemas on the
 * way out, and every object is strict, so a field somebody added on the daemon side without adding it
 * here fails the response rather than reaching a browser.
 *
 * ## Four words
 *
 * `ready`, `refresh_due`, `needs_sign_in`, `checking` — the closed set the fleet package owns
 * (`CredentialStatusWordSchema`). It is restated here because this package depends on nothing, and the
 * daemon proves the two spellings agree.
 */
import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';

const HarnessKindSchema = z.enum(['claude', 'codex']);

/** A credential id: the config's own slug. */
export const FleetCredentialIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u, 'a credential id uses only lowercase letters, digits and dashes')
  .max(64);

export const FleetCredentialStatusWordSchema = z.enum(['ready', 'refresh_due', 'needs_sign_in', 'checking']);
export type FleetCredentialStatusWord = z.infer<typeof FleetCredentialStatusWordSchema>;

/** Why the word is what it is: the fleet's closed set, restated (see the module note). */
export const FleetCredentialStatusReasonSchema = z.enum([
  'provider_accepted',
  'usage_scope_unavailable',
  'passive_usage_seen',
  'access_current',
  'refresh_accepted',
  'not_checked_yet',
  'api_key',
  'from_environment',
  'credential_unreadable',
  'access_expired_refreshable',
  'access_expiring',
  'last_refresh_old',
  'not_signed_in',
  'access_expired_no_refresh',
  'provider_rejected',
  'refresh_expired',
  'refresh_revoked',
  'refresh_rejected',
  'store_unreachable',
  'check_in_flight',
]);
export type FleetCredentialStatusReason = z.infer<typeof FleetCredentialStatusReasonSchema>;

/** Where a credential is kept (C3). */
export const FleetCredentialStoreSchema = z.enum(['host', 'ferretry', 'environment']);
export type FleetCredentialStore = z.infer<typeof FleetCredentialStoreSchema>;

/** One credential's status: the word, the sentence that explains it, and how old the evidence is. */
export const FleetCredentialStatusSchema = z.strictObject({
  word: FleetCredentialStatusWordSchema,
  /** The word as a person reads it: "Ready", "Refresh due", "Needs sign-in", "Checking". */
  label: NonEmptyStringSchema,
  /** The closed-set reason the fleet decided on, for a client that branches on cause. */
  reason: FleetCredentialStatusReasonSchema,
  /** One plain sentence saying why. */
  explanation: NonEmptyStringSchema,
  since: InstantSchema.optional(),
  lastCheckedAt: InstantSchema.optional(),
  /** The newest check could not conclude, so the word rests on older evidence (or none). */
  lastCheckInconclusive: z.boolean(),
  /** Codex: the plan the login is on. Display only. */
  planType: NonEmptyStringSchema.optional(),
});
export type FleetCredentialStatus = z.infer<typeof FleetCredentialStatusSchema>;

/** One rate-limit window. No `usedPercent` means nobody measured it: "unknown", never 0%. */
export const FleetCredentialUsageWindowSchema = z.strictObject({
  usedPercent: z.number().finite().min(0).optional(),
  resetsAt: InstantSchema.optional(),
});
export type FleetCredentialUsageWindow = z.infer<typeof FleetCredentialUsageWindowSchema>;

/**
 * Where an environment login's quota or spend is read from, as its preset declares it. The adapters
 * that read each one belong to the usage subsystem (`lib/usage/provider-quota`); this is only the
 * closed set they agree on.
 *
 * - `transcript-pricing` — no provider endpoint: tokens counted from the transcript times known prices.
 * - `none` — nothing to read (a local model): "usage unknown", never a made-up number.
 */
export const ProviderQuotaSourceSchema = z.enum([
  'zai-coding-plan',
  'moonshot-balance',
  'deepseek-balance',
  'minimax-token-plan',
  'openrouter-key',
  'litellm-key-info',
  'vercel-credits',
  'transcript-pricing',
  'none',
]);
export type ProviderQuotaSource = z.infer<typeof ProviderQuotaSourceSchema>;

/**
 * One window of a provider's quota, in the common shape every adapter maps to. Each field is present
 * only when the provider said it: a missing `used` is unknown, never 0.
 *
 * `label` is `5h`, `week` or `month` for a rolling or calendar window, `key` for an API key's own
 * spending limit and `tools` for a provider's separate tool-call allowance. `unit` says what `used`
 * and `limit` count; `usd` is money.
 */
export const ProviderQuotaWindowSchema = z.strictObject({
  label: z.enum(['5h', 'week', 'month', 'key', 'tools']),
  unit: z.enum(['requests', 'prompts', 'tokens', 'usd']).optional(),
  used: z.number().finite().min(0).optional(),
  limit: z.number().finite().min(0).optional(),
  usedPercent: z.number().finite().min(0).optional(),
  resetsAt: InstantSchema.optional(),
});
export type ProviderQuotaWindow = z.infer<typeof ProviderQuotaWindowSchema>;

/** Money left on a prepaid account or key, in the currency the provider reports it in. */
export const ProviderQuotaBalanceSchema = z.strictObject({
  amount: z.number().finite(),
  currency: z.string().regex(/^[A-Z]{3}$/u, 'a currency is a three-letter ISO code'),
});
export type ProviderQuotaBalance = z.infer<typeof ProviderQuotaBalanceSchema>;

/**
 * Equivalent cost counted from this daemon's own transcripts: the tokens its sessions on the login
 * spent, times known prices. `unpriced` sessions had no price, so the amount is a floor whenever it
 * is above zero.
 */
export const ProviderQuotaSpendSchema = z.strictObject({
  amountUsd: z.number().finite().min(0),
  since: InstantSchema,
  sessions: NonNegativeIntegerSchema,
  unpriced: NonNegativeIntegerSchema,
});
export type ProviderQuotaSpend = z.infer<typeof ProviderQuotaSpendSchema>;

/**
 * An environment login's quota, read the first way that works (docs/provider-quotas.md):
 *
 * 1. `endpoint` — the provider's own usage, quota or balance endpoint;
 * 2. `transcript` — this daemon's transcripts × known pricing;
 * 3. `unknown` — neither answered, and `note` says why. Nothing is made up.
 *
 * Rate-limit headers on the requests a ferret makes itself would sit between 1 and 2, and are a
 * DECLARED GAP: the CLI talks to the provider directly, so the daemon never sees them.
 */
export const ProviderQuotaReadingSchema = z.strictObject({
  source: ProviderQuotaSourceSchema,
  via: z.enum(['endpoint', 'transcript', 'unknown']),
  windows: z.array(ProviderQuotaWindowSchema).readonly(),
  balance: ProviderQuotaBalanceSchema.optional(),
  spend: ProviderQuotaSpendSchema.optional(),
  /** The provider said this login can do no more work now: a window full, or no credit left. */
  exhausted: z.boolean(),
  /** The endpoint or its fields are known from community sources, not the provider's own docs. */
  unverified: z.boolean(),
  /** Why the reading is what it is, in one plain sentence, when that is not obvious. */
  note: NonEmptyStringSchema.optional(),
  at: InstantSchema,
});
export type ProviderQuotaReading = z.infer<typeof ProviderQuotaReadingSchema>;

export const FleetCredentialUsageSchema = z.strictObject({
  fiveHour: FleetCredentialUsageWindowSchema,
  weekly: FleetCredentialUsageWindowSchema,
  /** Which reading the windows came from. Absent when nothing has measured this credential. */
  source: z.enum(['claude-statusline', 'codex-rollout', 'anthropic-usage', 'codex-usage', 'provider-quota']).optional(),
  at: InstantSchema.optional(),
  /**
   * An environment login's provider quota, when one has been read. Absent until somebody watches the
   * login (a screen open, or the Warden or failover asking): quota is never read on an idle timer.
   */
  provider: ProviderQuotaReadingSchema.optional(),
});
export type FleetCredentialUsage = z.infer<typeof FleetCredentialUsageSchema>;

/** Whether an act is offered for this credential, and the sentence that says why not when it is not. */
export const FleetCredentialActSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type FleetCredentialAct = z.infer<typeof FleetCredentialActSchema>;

/** What signing out would do (C7, E25), said before anybody confirms it. */
export const FleetCredentialSignOutSchema = z.strictObject({
  available: z.boolean(),
  /** The confirm card's question, consequences included: "Sign out of … ? This also signs out …". */
  sentence: NonEmptyStringSchema,
  /** How many runtimes will need sign-in afterwards. */
  runtimesAffected: NonNegativeIntegerSchema,
  /** `store: host` only: signing out also signs out the person's own CLI on this machine. */
  signsOutTerminal: z.boolean(),
});
export type FleetCredentialSignOut = z.infer<typeof FleetCredentialSignOutSchema>;

// ── Environment logins (docs/provider-presets.md) ───────────────────────────────────────────────

/**
 * A reference to a cloud credential this machine already has, kept as a REFERENCE and never copied:
 * `aws-profile:<name>`, `gcloud-adc` (the default application-default credentials), `gcloud-adc:<path>`
 * (a credentials file somewhere else) or `azure-cli` (whoever `az login` signed in).
 */
export const CLOUD_CREDENTIAL_KINDS = ['aws-profile', 'gcloud-adc', 'azure-cli'] as const;
export const CloudCredentialKindSchema = z.enum(CLOUD_CREDENTIAL_KINDS);
export type CloudCredentialKind = z.infer<typeof CloudCredentialKindSchema>;

/**
 * Which half of a login that drives both CLIs a variable belongs to (docs/provider-presets.md). Absent:
 * every CLI the login drives is given it.
 */
const HALF_SHAPE = { harness: HarnessKindSchema.optional() };

/** One variable of an environment login, as it may travel: a value, or a secret's NAME and whether it is set. */
export const FleetEnvironmentVariableSchema = z.discriminatedUnion('kind', [
  /** A plain value — a base URL, a region, a model id. Shown as it is. */
  z.strictObject({ name: NonEmptyStringSchema, kind: z.literal('plain'), value: z.string(), ...HALF_SHAPE }),
  /**
   * A value made from the secret store: `${secret:NAME}`, possibly inside a template. The value is
   * never read; `set` says whether the store holds every secret it names.
   */
  z.strictObject({
    name: NonEmptyStringSchema,
    kind: z.literal('secret'),
    secrets: z.array(NonEmptyStringSchema).min(1).readonly(),
    set: z.boolean(),
    ...HALF_SHAPE,
  }),
  /** A value that looks like a credential and is not a reference. Never shown. */
  z.strictObject({ name: NonEmptyStringSchema, kind: z.literal('hidden'), ...HALF_SHAPE }),
]);
export type FleetEnvironmentVariable = z.infer<typeof FleetEnvironmentVariableSchema>;

/** A cloud credential reference, said in words. */
export const FleetCloudCredentialViewSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  kind: CloudCredentialKindSchema,
  /** "Your AWS profile acme-dev on this machine". */
  sentence: NonEmptyStringSchema,
  /** The variable it is given to the CLI as, when it is given as one (`AWS_PROFILE`). */
  variable: NonEmptyStringSchema.optional(),
});
export type FleetCloudCredentialView = z.infer<typeof FleetCloudCredentialViewSchema>;

/** What a Test of this login would cost, and whether one is offered. */
export const FleetCredentialTestActSchema = z.discriminatedUnion('available', [
  z.strictObject({
    available: z.literal(true),
    /** `nothing`: a read such as a model list. `one-token`: one inference capped at one token, asked first. */
    spends: z.enum(['nothing', 'one-token']),
    /** What the Test does, in one sentence a person reads before pressing it. */
    note: NonEmptyStringSchema,
  }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type FleetCredentialTestAct = z.infer<typeof FleetCredentialTestActSchema>;

/** The parts of a login that only an environment login has. */
export const FleetCredentialEnvironmentSchema = z.strictObject({
  /** The preset it was made from, when there was one and it still exists. */
  preset: z
    .strictObject({ id: NonEmptyStringSchema, label: NonEmptyStringSchema, docs: NonEmptyStringSchema })
    .optional(),
  /** A preset id the login names that this machine no longer has. */
  missingPreset: NonEmptyStringSchema.optional(),
  variables: z.array(FleetEnvironmentVariableSchema).readonly(),
  cloudCredential: FleetCloudCredentialViewSchema.optional(),
  /** Codex only: the model provider it points Codex at. */
  codexProvider: z
    .strictObject({ id: NonEmptyStringSchema, name: NonEmptyStringSchema, baseUrl: NonEmptyStringSchema.optional() })
    .optional(),
  quotaSource: ProviderQuotaSourceSchema,
  /** Every secret it names that the store does not hold: "needs: GLM_API_KEY". */
  missingSecrets: z.array(NonEmptyStringSchema).readonly(),
  test: FleetCredentialTestActSchema,
});
export type FleetCredentialEnvironment = z.infer<typeof FleetCredentialEnvironmentSchema>;

/**
 * `POST /v1/fleet/credentials/:id/test`. `allowInference` is the person's consent to a one-token
 * inference, for a provider with no free authenticated read; without it such a Test is refused with
 * `consent_required` and nothing is sent.
 */
export const FleetCredentialTestRequestSchema = z.strictObject({ allowInference: z.boolean().optional() });
export type FleetCredentialTestRequest = z.infer<typeof FleetCredentialTestRequestSchema>;

/** What one Test proved, as a closed set a screen can branch on. */
export const FleetCredentialTestCodeSchema = z.enum([
  'ok',
  'not_set',
  'rejected',
  'rate_limited',
  'timeout',
  'unreachable',
  'provider_error',
  'malformed',
  'vault_damaged',
  'consent_required',
  'not_testable',
  'refused',
]);
export type FleetCredentialTestCode = z.infer<typeof FleetCredentialTestCodeSchema>;

export const FleetCredentialTestResultSchema = z.strictObject({
  credentialId: FleetCredentialIdSchema,
  ok: z.boolean(),
  code: FleetCredentialTestCodeSchema,
  /** One fixed sentence per code. Never a provider body: that could echo anything. */
  message: NonEmptyStringSchema,
  /** What the Test spent. `nothing` when nothing was sent. */
  spent: z.enum(['nothing', 'one-token']),
  latencyMs: z.number().finite().min(0).optional(),
  at: InstantSchema,
});
export type FleetCredentialTestResult = z.infer<typeof FleetCredentialTestResultSchema>;

/**
 * A login or runtime that is switched off, as a surface shows it (docs/disabling.md). `until` is the instant it
 * switches itself back on; `source` says which switch is holding a RUNTIME off — its own, or its login's.
 */
export const FleetDisabledSchema = z.strictObject({
  reason: NonEmptyStringSchema.max(200).optional(),
  until: InstantSchema.optional(),
  source: z.enum(['login', 'runtime']),
});
export type FleetDisabled = z.infer<typeof FleetDisabledSchema>;

/**
 * Where a login stands against one budget period, best to worst (docs/budgets.md): `over_trigger` means
 * nothing new starts on it; `over_hard` means its running ferrets were stopped too.
 */
export const FleetBudgetLevelSchema = z.enum(['ok', 'over_trigger', 'over_hard']);
export type FleetBudgetLevel = z.infer<typeof FleetBudgetLevelSchema>;

/** One budget period of one login: its limits as written, what this machine spent in it, and when it resets. */
export const FleetBudgetPeriodViewSchema = z.strictObject({
  trigger: z.number().finite().positive().optional(),
  hard: z.number().finite().positive().optional(),
  /** Dollars this machine's sessions on the login cost in the period, priced from their transcripts. */
  spentUsd: z.number().finite().nonnegative(),
  level: FleetBudgetLevelSchema,
  startsAt: InstantSchema,
  resetsAt: InstantSchema,
});
export type FleetBudgetPeriodView = z.infer<typeof FleetBudgetPeriodViewSchema>;

/**
 * A login's spend budget and where it stands. The spend is THIS MACHINE's only: each daemon meters the
 * sessions it runs, so the same login used on another machine spends against that machine's budget.
 */
export const FleetCredentialBudgetSchema = z.strictObject({
  /** The zone its days and weeks are counted in. */
  timeZone: NonEmptyStringSchema,
  /** Whether `timeZone` is written in machine.yaml; `false` means it is the host's own zone. */
  timeZoneSet: z.boolean(),
  daily: FleetBudgetPeriodViewSchema.optional(),
  weekly: FleetBudgetPeriodViewSchema.optional(),
  /** The worse of the periods. */
  level: FleetBudgetLevelSchema,
  /** Usage records in the periods whose model has no price: counted here, never as $0. */
  unpriced: NonNegativeIntegerSchema,
  /** `false` until the meter has read this login's sessions once since the daemon started. */
  measured: z.boolean(),
  /**
   * A transcript on this login holds more written this period than one read reaches back over, so the
   * spend is counted from where the read could start and may be LOW. Absent: every transcript was read whole.
   */
  partial: z.literal(true).optional(),
});
export type FleetCredentialBudget = z.infer<typeof FleetCredentialBudgetSchema>;

/** One credential, as the Credentials tab shows it. */
export const FleetCredentialViewSchema = z.strictObject({
  id: FleetCredentialIdSchema,
  harness: HarnessKindSchema,
  /**
   * Every CLI it drives, Claude Code first: one for a sign-in, both for an environment login with a
   * `claude:` and a `codex:` half (docs/provider-presets.md). Absent from a daemon that predates halves,
   * which means `[harness]`. A surface that picks a login for one CLI filters on this.
   */
  harnesses: z.array(HarnessKindSchema).min(1).readonly().optional(),
  store: FleetCredentialStoreSchema,
  /** The login's email, when the harness recorded one. Display only. */
  email: NonEmptyStringSchema.optional(),
  /** The person's own label (C9). Display only. */
  label: NonEmptyStringSchema.optional(),
  /**
   * Another login of this harness has the same email and the two are not told apart by distinct
   * labels (E26). A surface asks for a label rather than showing two identical rows.
   */
  needsLabel: z.boolean(),
  /** Switched off without deleting it: a start on any runtime of this login refuses, ferrets already on it keep going. */
  disabled: FleetDisabledSchema.optional(),
  /** Its spend budget, when it has one (`budget:` in its file). Absent from a daemon that predates budgets. */
  budget: FleetCredentialBudgetSchema.optional(),
  /** Set by Clone on an empty slot: the machine it was copied from, by the name it gave itself. */
  clonedFrom: NonEmptyStringSchema.optional(),
  /** That machine's daemon id as the copying browser reported it, so a surface can name it by its own label. */
  clonedFromDaemon: NonEmptyStringSchema.optional(),
  /** `store: host`: "Shared with claude in your terminal" (C4). */
  sharedWithTerminal: z.boolean(),
  status: FleetCredentialStatusSchema,
  usage: FleetCredentialUsageSchema,
  /** The runtimes that use this credential, by name. */
  usedBy: z.array(NonEmptyStringSchema).readonly(),
  /** Whether `POST /v1/fleet/login` can sign this credential in. */
  signIn: FleetCredentialActSchema,
  /** Whether `POST /v1/fleet/credentials/:id/check` can run. */
  checkNow: FleetCredentialActSchema,
  signOut: FleetCredentialSignOutSchema,
  /** `store: environment` only: its variables, its preset, what it still needs and its Test. */
  environment: FleetCredentialEnvironmentSchema.optional(),
});
export type FleetCredentialView = z.infer<typeof FleetCredentialViewSchema>;

/**
 * Every credential on this machine.
 *
 * `format` is the config document's version, which is always the account model: a machine whose
 * retired single-file config.yaml is still there is refused as unreadable rather than listed.
 */
export const FleetCredentialListSchema = z.strictObject({
  format: z.literal(2),
  /** This machine's name, as the sign-out sentence names it. */
  machine: NonEmptyStringSchema,
  credentials: z.array(FleetCredentialViewSchema).readonly(),
});
export type FleetCredentialList = z.infer<typeof FleetCredentialListSchema>;

/** A person's **Check now**. Empty: a governed caller's confirmation is the `fleet.configure` step-up. */
export const FleetCredentialCheckRequestSchema = z.strictObject({});
export type FleetCredentialCheckRequest = z.infer<typeof FleetCredentialCheckRequestSchema>;

// ── Provider presets ─────────────────────────────────────────────────────────────────────────────

/** One variable a preset fills in. */
export const FleetPresetVariableSchema = z.strictObject({
  name: NonEmptyStringSchema,
  kind: z.enum(['plain', 'secret']),
  /** A plain variable's value as the preset fills it in; empty when the person must type one. */
  value: z.string().optional(),
  /** A secret variable's suggested secret NAME. */
  secret: NonEmptyStringSchema.optional(),
  /** Whether the login needs it. An optional variable left empty is left out. */
  required: z.boolean(),
  /** Whether an empty value is a deliberate value (`ANTHROPIC_API_KEY: ""`, so a token is the one sent). */
  allowEmpty: z.boolean(),
  /** What it is for, in a few words. */
  description: NonEmptyStringSchema.optional(),
  /** The halves that set it, for a preset that drives both CLIs. Absent: the preset's one CLI. */
  harnesses: z.array(HarnessKindSchema).min(1).readonly().optional(),
});
export type FleetPresetVariable = z.infer<typeof FleetPresetVariableSchema>;

/**
 * A preset's detection clues: hosts a base URL goes to, variable names (`PREFIX_*` for a family) only
 * it uses, and the documented start of its keys. Facts about the provider, never anybody's values.
 */
export const FleetPresetDetectSchema = z.strictObject({
  hosts: z.array(NonEmptyStringSchema).readonly(),
  variables: z.array(NonEmptyStringSchema).readonly(),
  keyPrefixes: z.array(NonEmptyStringSchema).readonly(),
});
export type FleetPresetDetect = z.infer<typeof FleetPresetDetectSchema>;

/**
 * Where a preset sits in the Add a login grid: the providers most people pick, the clouds that host
 * Claude, and what a person runs themselves. A preset with no group is listed after the clouds.
 */
export const FleetPresetGroupSchema = z.enum(['popular', 'cloud', 'self-hosted']);
export type FleetPresetGroup = z.infer<typeof FleetPresetGroupSchema>;

/** A preset, as the Add a login flow offers it. */
export const FleetProviderPresetViewSchema = z.strictObject({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  harness: HarnessKindSchema,
  summary: NonEmptyStringSchema,
  docs: NonEmptyStringSchema,
  /** Its heading in the Add a login grid. Absent when it has none, or from a daemon that predates groups. */
  group: FleetPresetGroupSchema.optional(),
  /** Shipped with Ferretry, or a file in this machine's `config/presets/`. */
  origin: z.enum(['built-in', 'file']),
  variables: z.array(FleetPresetVariableSchema).readonly(),
  /** The cloud credential references it accepts, and the one it suggests. */
  cloudCredential: z
    .strictObject({ kinds: z.array(CloudCredentialKindSchema).min(1).readonly(), suggested: NonEmptyStringSchema })
    .optional(),
  /** Model ids the provider recommends, for display. */
  models: z.array(NonEmptyStringSchema).readonly(),
  test: FleetCredentialTestActSchema,
  quota: z.strictObject({ source: ProviderQuotaSourceSchema, note: NonEmptyStringSchema }),
  /** What could not be confirmed against the provider's own documentation, said plainly. */
  unverified: z.array(NonEmptyStringSchema).readonly(),
  /** When its facts were last checked against the provider's documentation (YYYY-MM-DD). */
  verified: NonEmptyStringSchema,
  /** Whether it can be used to add a login here, and why not when it cannot. */
  offered: FleetCredentialActSchema,
  /**
   * Each CLI it has a half for, and whether that half is offered: a login from it drives every offered
   * one with one secret (docs/provider-presets.md). Absent from a daemon that predates halves, which
   * means `harness` alone.
   */
  halves: z
    .array(
      z.strictObject({
        harness: HarnessKindSchema,
        offered: FleetCredentialActSchema,
        /** This CLI's own guide at the provider, when it has one apart from `docs`. */
        docs: NonEmptyStringSchema.optional(),
        models: z.array(NonEmptyStringSchema).readonly(),
      }),
    )
    .min(1)
    .readonly()
    .optional(),
  /** How a pasted set of variables is recognised as this provider's (`@ferretry/fleet/detect`). */
  detect: FleetPresetDetectSchema.optional(),
});
export type FleetProviderPresetView = z.infer<typeof FleetProviderPresetViewSchema>;

/**
 * `GET /v1/fleet/presets`: every preset this machine offers — the built-in catalogue, then each preset
 * file in `config/presets/` that checks (a broken one is reported by `GET /v1/config/status`).
 */
export const FleetProviderPresetCatalogSchema = z.strictObject({
  presets: z.array(FleetProviderPresetViewSchema).readonly(),
});
export type FleetProviderPresetCatalog = z.infer<typeof FleetProviderPresetCatalogSchema>;

/** The daemon address of the preset catalogue. */
export const FLEET_PRESETS_PATH = '/v1/fleet/presets';
