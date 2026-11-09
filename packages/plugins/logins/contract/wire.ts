/**
 * Logins' wire schemas, copied from today's `@ferretry/protocol` (`fleet-credentials.ts`, `harness-login.ts`,
 * `models.ts`) field for field. Every object stays strict, and no field can carry an access token, a refresh token or
 * a digest of either (docs/secrets.md: no route returns a secret value; the types enforce it).
 *
 * CHANGES FROM TODAY, all renames or clean-slate cuts:
 * - the word is **login**, not credential: `FleetCredential*` is `Login*`, `credentialId` is `loginId`, the path
 *   parameter is `:loginId`;
 * - the harness key is the harness plugin's id (`claude` → `claude-code`), via `HarnessKeySchema`;
 * - `LoginListSchema.format` is `1` (every stored or served format starts at 1);
 * - small foreign pieces are inlined here instead of imported: `LoginIdSchema` (today `LoginIdSchema`),
 *   the secret-name reference is a plain non-empty string, `InstantSchema`/`NonEmptyStringSchema`/
 *   `NonNegativeIntegerSchema` come from `@ferretry/std`;
 * - the budget and disabled views are kept; the reading of them is the port's.
 */
import { type Brand, InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import { HarnessKeySchema } from '@ferretry/core-ferrets/contract';
import { malformedSecretReference } from '@ferretry/core-vault/contract';
import { storedEnvironmentIssue } from './secret-shape.ts';

const HarnessKindSchema = HarnessKeySchema;
const NonEmpty = z.string().min(1);

/**
 * A login's id: the config's own slug (the file name under `logins/`). Branded so Usage and Runtimes can hold one
 * without taking any string. Usage imports this (§2.4: Usage -> Logins).
 */
export type LoginId = Brand<string, 'LoginId'>;
export const LoginIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u, 'a login id uses only lowercase letters, digits and dashes')
  .max(64)
  .transform(value => value as LoginId);

export const LoginStatusWordSchema = z.enum(['ready', 'refresh_due', 'needs_sign_in', 'checking']);
export type LoginStatusWord = z.infer<typeof LoginStatusWordSchema>;

/** Why the word is what it is: the fleet's closed set, restated (see the module note). */
export const LoginStatusReasonSchema = z.enum([
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
export type LoginStatusReason = z.infer<typeof LoginStatusReasonSchema>;

/** Where a credential is kept (C3). */
export const LoginStoreSchema = z.enum(['host', 'ferretry', 'environment']);
export type LoginStore = z.infer<typeof LoginStoreSchema>;

/** One credential's status: the word, the sentence that explains it, and how old the evidence is. */
export const LoginStatusSchema = z.strictObject({
  word: LoginStatusWordSchema,
  /** The word as a person reads it: "Ready", "Refresh due", "Needs sign-in", "Checking". */
  label: NonEmptyStringSchema,
  /** The closed-set reason the fleet decided on, for a client that branches on cause. */
  reason: LoginStatusReasonSchema,
  /** One plain sentence saying why. */
  explanation: NonEmptyStringSchema,
  since: InstantSchema.optional(),
  lastCheckedAt: InstantSchema.optional(),
  /** The newest check could not conclude, so the word rests on older evidence (or none). */
  lastCheckInconclusive: z.boolean(),
  /** Codex: the plan the login is on. Display only. */
  planType: NonEmptyStringSchema.optional(),
});
export type LoginStatus = z.infer<typeof LoginStatusSchema>;

/** One rate-limit window. No `usedPercent` means nobody measured it: "unknown", never 0%. */
export const LoginUsageWindowSchema = z.strictObject({
  usedPercent: z.number().finite().min(0).optional(),
  resetsAt: InstantSchema.optional(),
});
export type LoginUsageWindow = z.infer<typeof LoginUsageWindowSchema>;

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

export const LoginUsageSchema = z.strictObject({
  fiveHour: LoginUsageWindowSchema,
  weekly: LoginUsageWindowSchema,
  /** Which reading the windows came from. Absent when nothing has measured this credential. */
  source: z.enum(['claude-statusline', 'codex-rollout', 'anthropic-usage', 'codex-usage', 'provider-quota']).optional(),
  at: InstantSchema.optional(),
  /**
   * An environment login's provider quota, when one has been read. Absent until somebody watches the
   * login (a screen open, or the Warden or failover asking): quota is never read on an idle timer.
   */
  provider: ProviderQuotaReadingSchema.optional(),
});
export type LoginUsage = z.infer<typeof LoginUsageSchema>;

/** Whether an act is offered for this credential, and the sentence that says why not when it is not. */
export const LoginActSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type LoginAct = z.infer<typeof LoginActSchema>;

/** What signing out would do (C7, E25), said before anybody confirms it. */
export const LoginSignOutSchema = z.strictObject({
  available: z.boolean(),
  /** The confirm card's question, consequences included: "Sign out of … ? This also signs out …". */
  sentence: NonEmptyStringSchema,
  /** How many runtimes will need sign-in afterwards. */
  runtimesAffected: NonNegativeIntegerSchema,
  /** `store: host` only: signing out also signs out the person's own CLI on this machine. */
  signsOutTerminal: z.boolean(),
});
export type LoginSignOut = z.infer<typeof LoginSignOutSchema>;

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
export const LoginEnvironmentVariableSchema = z.discriminatedUnion('kind', [
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
export type LoginEnvironmentVariable = z.infer<typeof LoginEnvironmentVariableSchema>;

/** A cloud credential reference, said in words. */
export const LoginCloudCredentialViewSchema = z.strictObject({
  reference: NonEmptyStringSchema,
  kind: CloudCredentialKindSchema,
  /** "Your AWS profile acme-dev on this machine". */
  sentence: NonEmptyStringSchema,
  /** The variable it is given to the CLI as, when it is given as one (`AWS_PROFILE`). */
  variable: NonEmptyStringSchema.optional(),
});
export type LoginCloudCredentialView = z.infer<typeof LoginCloudCredentialViewSchema>;

/** What a Test of this login would cost, and whether one is offered. */
export const LoginTestActSchema = z.discriminatedUnion('available', [
  z.strictObject({
    available: z.literal(true),
    /** `nothing`: a read such as a model list. `one-token`: one inference capped at one token, asked first. */
    spends: z.enum(['nothing', 'one-token']),
    /** What the Test does, in one sentence a person reads before pressing it. */
    note: NonEmptyStringSchema,
  }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type LoginTestAct = z.infer<typeof LoginTestActSchema>;

/** The parts of a login that only an environment login has. */
export const LoginEnvironmentSchema = z.strictObject({
  /** The preset it was made from, when there was one and it still exists. */
  preset: z
    .strictObject({ id: NonEmptyStringSchema, label: NonEmptyStringSchema, docs: NonEmptyStringSchema })
    .optional(),
  /** A preset id the login names that this machine no longer has. */
  missingPreset: NonEmptyStringSchema.optional(),
  variables: z.array(LoginEnvironmentVariableSchema).readonly(),
  cloudCredential: LoginCloudCredentialViewSchema.optional(),
  /** Codex only: the model provider it points Codex at. */
  codexProvider: z
    .strictObject({ id: NonEmptyStringSchema, name: NonEmptyStringSchema, baseUrl: NonEmptyStringSchema.optional() })
    .optional(),
  quotaSource: ProviderQuotaSourceSchema,
  /** Every secret it names that the store does not hold: "needs: GLM_API_KEY". */
  missingSecrets: z.array(NonEmptyStringSchema).readonly(),
  test: LoginTestActSchema,
});
export type LoginEnvironment = z.infer<typeof LoginEnvironmentSchema>;

/**
 * `POST /v1/logins/:loginId/test`. `allowInference` is the person's consent to a one-token
 * inference, for a provider with no free authenticated read; without it such a Test is refused with
 * `consent_required` and nothing is sent.
 */
export const LoginTestRequestSchema = z.strictObject({ allowInference: z.boolean().optional() });
export type LoginTestRequest = z.infer<typeof LoginTestRequestSchema>;

/** What one Test proved, as a closed set a screen can branch on. */
export const LoginTestCodeSchema = z.enum([
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
export type LoginTestCode = z.infer<typeof LoginTestCodeSchema>;

export const LoginTestResultSchema = z.strictObject({
  loginId: LoginIdSchema,
  ok: z.boolean(),
  code: LoginTestCodeSchema,
  /** One fixed sentence per code. Never a provider body: that could echo anything. */
  message: NonEmptyStringSchema,
  /** What the Test spent. `nothing` when nothing was sent. */
  spent: z.enum(['nothing', 'one-token']),
  latencyMs: z.number().finite().min(0).optional(),
  at: InstantSchema,
});
export type LoginTestResult = z.infer<typeof LoginTestResultSchema>;

/**
 * A login or runtime that is switched off, as a surface shows it (docs/disabling.md). `until` is the instant it
 * switches itself back on; `source` says which switch is holding a RUNTIME off — its own, or its login's.
 */
export const LoginDisabledSchema = z.strictObject({
  reason: NonEmptyStringSchema.max(200).optional(),
  until: InstantSchema.optional(),
  source: z.enum(['login', 'runtime']),
});
export type LoginDisabled = z.infer<typeof LoginDisabledSchema>;

/**
 * Where a login stands against one budget period, best to worst (docs/budgets.md): `over_trigger` means
 * nothing new starts on it; `over_hard` means its running ferrets were stopped too.
 */
export const LoginBudgetLevelSchema = z.enum(['ok', 'over_trigger', 'over_hard']);
export type LoginBudgetLevel = z.infer<typeof LoginBudgetLevelSchema>;

/** One budget period of one login: its limits as written, what this machine spent in it, and when it resets. */
export const LoginBudgetPeriodViewSchema = z.strictObject({
  trigger: z.number().finite().positive().optional(),
  hard: z.number().finite().positive().optional(),
  /** Dollars this machine's sessions on the login cost in the period, priced from their transcripts. */
  spentUsd: z.number().finite().nonnegative(),
  level: LoginBudgetLevelSchema,
  startsAt: InstantSchema,
  resetsAt: InstantSchema,
});
export type LoginBudgetPeriodView = z.infer<typeof LoginBudgetPeriodViewSchema>;

/**
 * A login's spend budget and where it stands. The spend is THIS MACHINE's only: each daemon meters the
 * sessions it runs, so the same login used on another machine spends against that machine's budget.
 */
export const LoginBudgetSchema = z.strictObject({
  /** The zone its days and weeks are counted in. */
  timeZone: NonEmptyStringSchema,
  /** Whether `timeZone` is written in machine.yaml; `false` means it is the host's own zone. */
  timeZoneSet: z.boolean(),
  daily: LoginBudgetPeriodViewSchema.optional(),
  weekly: LoginBudgetPeriodViewSchema.optional(),
  /** The worse of the periods. */
  level: LoginBudgetLevelSchema,
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
export type LoginBudget = z.infer<typeof LoginBudgetSchema>;

/** One credential, as the Sign-ins tab shows it. */
export const LoginViewSchema = z.strictObject({
  id: LoginIdSchema,
  harness: HarnessKindSchema,
  /** Every harness it drives, Claude Code first: one for a sign-in, both for an environment login with a `claude-code:` and a `codex:` half. */
  harnesses: z.array(HarnessKindSchema).min(1).readonly(),
  store: LoginStoreSchema,
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
  disabled: LoginDisabledSchema.optional(),
  /** Its spend budget, when it has one (`budget:` in its file). */
  budget: LoginBudgetSchema.optional(),
  /** Set by Clone on an empty slot: the machine it was copied from, by the name it gave itself. */
  clonedFrom: NonEmptyStringSchema.optional(),
  /** That machine's daemon id as the copying browser reported it, so a surface can name it by its own label. */
  clonedFromDaemon: NonEmptyStringSchema.optional(),
  /** `store: host`: "Shared with claude in your terminal" (C4). */
  sharedWithTerminal: z.boolean(),
  status: LoginStatusSchema,
  usage: LoginUsageSchema,
  /** The runtimes that use this credential, by name. */
  usedBy: z.array(NonEmptyStringSchema).readonly(),
  /** Whether `POST /v1/logins/sign-in` can sign this credential in. */
  signIn: LoginActSchema,
  /** Whether `POST /v1/logins/:loginId/check` can run. */
  checkNow: LoginActSchema,
  signOut: LoginSignOutSchema,
  /** `store: environment` only: its variables, its preset, what it still needs and its Test. */
  environment: LoginEnvironmentSchema.optional(),
});
export type LoginView = z.infer<typeof LoginViewSchema>;

/**
 * Every login on this machine.
 *
 * `format` is the document version, which starts at 1.
 */
export const LoginListSchema = z.strictObject({
  format: z.literal(1),
  /** This machine's name, as the sign-out sentence names it. */
  machine: NonEmptyStringSchema,
  logins: z.array(LoginViewSchema).readonly(),
});
export type LoginList = z.infer<typeof LoginListSchema>;

/** A person's **Check now**. Empty: a governed caller's confirmation is the `fleet.configure` step-up. */
export const LoginCheckRequestSchema = z.strictObject({});
export type LoginCheckRequest = z.infer<typeof LoginCheckRequestSchema>;

// ── Login changes (today's `credential.*` account changes, owned here) ─────────────────────────────────────────────
//
// A caller names ONE intent and the daemon derives the login file it means, holds it for review, and applies exactly
// what was previewed. The seven intents are the ones a person makes of a single login; a runtime's switch or removal
// along with it (today's `switchRuntimes`/`removeRuntimes`) is Runtimes' to carry out before it asks for the removal.

const POSIX_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const EnvNameSchema = z.string().regex(POSIX_ENV_NAME, 'a POSIX environment variable name');

/**
 * Variables a login's environment may never set, because Ferretry sets them and a second writer would lie. The first
 * three bind a harness to the configuration directory Ferretry derives from the runtime; `CLAUDE_SECURESTORAGE_CONFIG_DIR`
 * binds a Claude runtime to its credential, so a value set here could point a runtime at another login's store.
 */
export const RESERVED_LOGIN_ENV_NAMES = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CODEX_SQLITE_HOME',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
] as const;

/**
 * The one check every login environment passes, wherever it is written (a login file, a harness half, `login.add`,
 * `login.env`): no reserved variable, and no malformed `${secret:…}` reference (which would be exported as literal
 * text and fail as a credential with no visible cause). A refusal names the KEY only, never the value.
 */
const MAX_ENVIRONMENT_NAME = 128;

const refuseUnsafeEnvironment = (ctx: {
  readonly value: Readonly<Record<string, unknown>>;
  readonly issues: z.core.$ZodRawIssue[];
}): void => {
  for (const [name, value] of Object.entries(ctx.value)) {
    if (name.length > MAX_ENVIRONMENT_NAME) {
      // The record leaves no key out any more, so the rule sees every name. Nothing can vouch that the value under a name this long holds no key.
      ctx.issues.push({
        code: 'custom',
        message: `A variable name is longer than ${MAX_ENVIRONMENT_NAME} characters: a variable name is short, and the value under it is not read`,
        input: name.slice(0, 16),
        path: [name],
        params: { rawSecret: true },
        continue: true,
      });
    } else if (!POSIX_ENV_NAME.test(name)) {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" must be a POSIX environment variable name`,
        input: name,
        path: [name],
        continue: true,
      });
    } else if ((RESERVED_LOGIN_ENV_NAMES as readonly string[]).includes(name)) {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" is reserved: Ferretry sets it for the runtime itself`,
        input: name,
        path: [name],
        continue: true,
      });
    } else if (typeof value === 'string' && malformedSecretReference(value) !== undefined) {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" holds a malformed secret reference: a secret name is uppercase letters, digits and underscores, as in \${secret:WORK_KEY}`,
        input: name,
        path: [name],
        continue: true,
      });
    }
  }
};

/**
 * The longest value a login's environment variable may hold, on the wire and in a file.
 */
const MAX_ENVIRONMENT_VALUE = 4096;

/**
 * The ONE builder of a login's environment record, for the login file, the harness half, `login.add` and `login.env`:
 * the key is any string at the record (a key the record dropped would never reach the stored-secret rule), and
 * `refuseUnsafeEnvironment` refuses every unsafe key (over 128 characters, not POSIX, reserved) and value (malformed
 * reference) together, so a file with two faults reports both.
 */
const loginEnvironment = <V extends z.ZodType>(value: V) => z.record(z.string(), value).check(refuseUnsafeEnvironment);

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What a login FILE's environment may not hold: a secret value, or an address carrying one. The same rule the staging route
 * applies ({@link storedEnvironmentIssue}), so a file written by the config editor or `config_write` is judged as a login
 * add is. A value over 4096 characters (the wire's cap) is refused here, as a marked issue, and is NOT scanned: nothing can
 * vouch that an over-long value holds no key, which is also why the scan stays linear. A refusal names the VARIABLE only,
 * never the value, and is marked `rawSecret`, so the kernel withholds the file's text from `config_read` whatever ELSE is
 * wrong with the file, as for a file holding a raw key. A file that fails is reported invalid: an edit keeps the last good
 * version in effect, but a file saved before this rule is not in effect until it is fixed (the kernel re-checks the accepted
 * text at start).
 */
const refuseStoredSecrets = (ctx: { readonly value: unknown; readonly issues: z.core.$ZodRawIssue[] }): void => {
  // The check runs even when the record's own type check failed, so the value can be anything (null for a blank `env:`).
  // An environment that is not a map, or a value under it that is not a string, cannot be judged, so it is withheld.
  if (!isPlainObject(ctx.value)) {
    ctx.issues.push({
      code: 'custom',
      message: 'env must be a map of NAME: value',
      input: undefined,
      path: [],
      params: { rawSecret: true },
    });
    return;
  }
  for (const [name, value] of Object.entries(ctx.value)) {
    if (typeof value !== 'string') {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}": env must be a map of NAME: value`,
        input: name,
        path: [name],
        params: { rawSecret: true },
      });
      continue;
    }
    if (value.length > MAX_ENVIRONMENT_VALUE) {
      ctx.issues.push({
        code: 'custom',
        message: `"${name}" is longer than ${MAX_ENVIRONMENT_VALUE} characters: keep a long value in the secret store and write \${secret:NAME} here`,
        input: name,
        path: [name],
        params: { rawSecret: true },
      });
      continue;
    }
    const issue = storedEnvironmentIssue(name, value);
    if (issue === undefined) continue;
    ctx.issues.push({
      code: 'custom',
      message:
        issue === 'secret'
          ? `"${name}" holds a secret: save it in the secret store and write \${secret:NAME} here instead`
          : `"${name}" is an address holding a ${issue === 'userinfo' ? 'password' : 'key in its query string'}: write the address without it and keep it in the secret store`,
      input: name,
      path: [name],
      params: { rawSecret: true },
    });
  }
};

/** A login's environment: POSIX names, plain values or `${secret:NAME}` references, no reserved variable, no secret value. */
export const LoginEnvSchema = loginEnvironment(z.string()).check(alwaysRun(refuseStoredSecrets));

/**
 * A check that runs even when an earlier issue (an over-long variable NAME, which the record raises before any check) has
 * already failed the value: zod skips a later check after a non-continuable issue unless it says `when` it runs. The secret
 * rule must run beside every other fault, so a file's text is never shown just because it has a second mistake.
 */
function alwaysRun<T>(check: (payload: z.core.ParsePayload<T>) => void): z.core.$ZodCheck<T> {
  const wrapped = z.check<T>(check);
  wrapped._zod.def.when = () => true;
  return wrapped;
}

const ChangeLabelSchema = NonEmptyStringSchema.max(200);

export const LoginChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('login.add'),
    id: z.string().min(1).max(200),
    /** The CLI. For a preset with both halves, the one listed first. */
    harness: HarnessKindSchema,
    label: ChangeLabelSchema.optional(),
    /** Absent (or `ferretry`) is an empty slot Ferretry keeps; `host` is the person's own login, shared in place. */
    store: LoginStoreSchema.optional(),
    /** `store: environment` only: the preset it is made from. */
    preset: NonEmptyStringSchema.max(64).optional(),
    /** `store: environment` only: each variable as a plain value or a `${secret:NAME}` reference. */
    env: loginEnvironment(z.string().max(MAX_ENVIRONMENT_VALUE)).optional(),
    /** `store: environment` only: `aws-profile:<name>`, `gcloud-adc[:<path>]` or `azure-cli`. */
    cloudCredential: NonEmptyStringSchema.max(512).optional(),
  }),
  z.strictObject({
    /**
     * Change an environment login's variables (today's `credential.env`). A variable the list shows as hidden is
     * kept with `{ keep: true }`; a secret is only ever a `${secret:NAME}` reference. `cloudCredential: null` removes
     * the reference.
     */
    kind: z.literal('login.env'),
    id: NonEmptyStringSchema,
    env: loginEnvironment(z.union([z.string().max(MAX_ENVIRONMENT_VALUE), z.strictObject({ keep: z.literal(true) })])),
    cloudCredential: NonEmptyStringSchema.max(512).nullable().optional(),
  }),
  z.strictObject({ kind: z.literal('login.label'), id: NonEmptyStringSchema, label: ChangeLabelSchema.nullable() }),
  z.strictObject({ kind: z.literal('login.remove'), id: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal('login.signout'), id: NonEmptyStringSchema }),
  z.strictObject({
    kind: z.literal('login.disable'),
    id: NonEmptyStringSchema,
    reason: NonEmptyStringSchema.max(200).optional(),
    until: InstantSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('login.enable'), id: NonEmptyStringSchema }),
]);
export type LoginChange = z.infer<typeof LoginChangeSchema>;

/** A change held for review: what it does, in sentences, and when the hold ends. */
export const LoginChangeViewSchema = z.strictObject({
  id: NonEmptyStringSchema,
  change: LoginChangeSchema,
  summary: NonEmptyStringSchema,
  /** The sentences a confirm card shows: who else it changes, what it signs out, what it leaves behind. */
  consequences: z.array(NonEmptyStringSchema).readonly(),
  /** Secret NAMES (never values) that only a removed login referred to: left in the store, said aloud. */
  orphanedSecrets: z.array(NonEmptyStringSchema).readonly().optional(),
  expiresAt: InstantSchema,
  state: z.enum(['pending', 'consumed']),
});
export type LoginChangeView = z.infer<typeof LoginChangeViewSchema>;

/**
 * What applying a change did. `held`: the file was written but it loosens something (a removed budget), so the
 * tighter version stays in effect until the owner confirms; `sentences` say what widened.
 */
export const LoginChangeOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('applied') }),
  z.strictObject({ outcome: z.literal('held'), sentences: z.array(NonEmptyStringSchema).readonly() }),
  z.strictObject({ outcome: z.literal('signed-out'), login: LoginViewSchema }),
  z.strictObject({ outcome: z.literal('sign-out-failed'), reason: NonEmptyStringSchema, login: LoginViewSchema }),
]);
export type LoginChangeOutcome = z.infer<typeof LoginChangeOutcomeSchema>;

/** Every refusal a change answers with, so a client branches on cause. */
export const LOGIN_CHANGE_REFUSAL_CODES = [
  'login_change_refused',
  'login_change_unknown',
  'login_change_expired',
  'login_change_consumed',
  'login_change_stale',
  'login_change_failed',
] as const;
export type LoginChangeRefusalCode = (typeof LOGIN_CHANGE_REFUSAL_CODES)[number];

// ── Provider presets ─────────────────────────────────────────────────────────────────────────────

/** One variable a preset fills in. */
export const PresetVariableSchema = z.strictObject({
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
  harnesses: z.array(HarnessKindSchema).min(1).readonly(),
});
export type PresetVariable = z.infer<typeof PresetVariableSchema>;

/**
 * A preset's detection clues: hosts a base URL goes to, variable names (`PREFIX_*` for a family) only
 * it uses, and the documented start of its keys. Facts about the provider, never anybody's values.
 */
export const PresetDetectSchema = z.strictObject({
  hosts: z.array(NonEmptyStringSchema).readonly(),
  variables: z.array(NonEmptyStringSchema).readonly(),
  keyPrefixes: z.array(NonEmptyStringSchema).readonly(),
});
export type PresetDetect = z.infer<typeof PresetDetectSchema>;

/**
 * Where a preset sits in the Add a login grid: the providers most people pick, the clouds that host
 * Claude, and what a person runs themselves. A preset with no group is listed after the clouds.
 */
export const PresetGroupSchema = z.enum(['popular', 'cloud', 'self-hosted']);
export type PresetGroup = z.infer<typeof PresetGroupSchema>;

/** A preset, as the Add a login flow offers it. */
export const ProviderPresetViewSchema = z.strictObject({
  id: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  harness: HarnessKindSchema,
  summary: NonEmptyStringSchema,
  docs: NonEmptyStringSchema,
  /** Its heading in the Add a login grid. Absent when it has none. */
  group: PresetGroupSchema.optional(),
  /** Shipped with Ferretry, or a file in this machine's `config/presets/`. */
  origin: z.enum(['built-in', 'file']),
  variables: z.array(PresetVariableSchema).readonly(),
  /** The cloud credential references it accepts, and the one it suggests. */
  cloudCredential: z
    .strictObject({ kinds: z.array(CloudCredentialKindSchema).min(1).readonly(), suggested: NonEmptyStringSchema })
    .optional(),
  /** Model ids the provider recommends, for display. */
  models: z.array(NonEmptyStringSchema).readonly(),
  test: LoginTestActSchema,
  quota: z.strictObject({ source: ProviderQuotaSourceSchema, note: NonEmptyStringSchema }),
  /** What could not be confirmed against the provider's own documentation, said plainly. */
  unverified: z.array(NonEmptyStringSchema).readonly(),
  /** When its facts were last checked against the provider's documentation (YYYY-MM-DD). */
  verified: NonEmptyStringSchema,
  /** Whether it can be used to add a login here, and why not when it cannot. */
  offered: LoginActSchema,
  /**
   * Each CLI it has a half for, and whether that half is offered: a login from it drives every offered
   * one with one secret (docs/provider-presets.md).
   */
  halves: z
    .array(
      z.strictObject({
        harness: HarnessKindSchema,
        offered: LoginActSchema,
        /** This CLI's own guide at the provider, when it has one apart from `docs`. */
        docs: NonEmptyStringSchema.optional(),
        models: z.array(NonEmptyStringSchema).readonly(),
      }),
    )
    .min(1)
    .readonly(),
  /** How a pasted set of variables is recognised as this provider's (`@ferretry/fleet/detect`). */
  detect: PresetDetectSchema.optional(),
});
export type ProviderPresetView = z.infer<typeof ProviderPresetViewSchema>;

/**
 * `GET /v1/logins/presets`: every preset this machine offers — the built-in catalogue, then each preset
 * file in `config/presets/` that checks (a broken one is reported by the config status read).
 */
export const ProviderPresetCatalogSchema = z.strictObject({
  presets: z.array(ProviderPresetViewSchema).readonly(),
});
export type ProviderPresetCatalog = z.infer<typeof ProviderPresetCatalogSchema>;

// ── A login's sign-in flow (docs/design/harness-login.md) ─────────────────────────────────────────────────

/**
 * A URL a person will be sent to open.
 *
 * `z.url()` alone accepts `javascript:` and `data:`, which is a rendered link this browser would
 * happily activate, so the scheme is checked rather than assumed. Userinfo is refused for the reason
 * `AnalyticsPricingSourceUrlSchema` refuses it: a credential in an address is a credential in every
 * log, screenshot and copy-paste that address reaches. A query string is allowed and required in
 * practice — Claude's authorization URL carries its PKCE challenge and state there.
 */
export const HarnessLoginVerificationUrlSchema = z
  .url()
  .max(4_096)
  .superRefine((value, context) => {
    // A value that is not a URL at all already failed the format check; re-parsing it here would add
    // a second, worse message for the same defect.
    if (!URL.canParse(value)) return;
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', message: 'a verification URL must be https' });
    }
    if (url.username !== '' || url.password !== '') {
      context.addIssue({ code: 'custom', message: 'a verification URL may not carry credentials' });
    }
  });

/**
 * The one-time code a person types at the provider, for a device grant.
 *
 * Bounded and shape-checked because it is rendered verbatim and read aloud: two groups of uppercase
 * alphanumerics joined by a hyphen is what `codex login --device-auth` prints (observed `0IER-FFQW6`
 * at codex-cli 0.145.0). A value that is not that shape is not a user code, and publishing arbitrary
 * text under that label would put unclassified child output on the wire — which §3.3 rule 2 forbids.
 */
export const HarnessLoginUserCodeSchema = z
  .string()
  .regex(/^[0-9A-Z]{3,8}-[0-9A-Z]{3,8}$/u, 'a device user code is two alphanumeric groups joined by a hyphen');

/**
 * What a renewal did to one identity's credential — the sibling of a login, and never a login.
 *
 * A renewal asks the harness to rotate a credential it can already rotate. Nobody is sent anywhere, no
 * browser opens, and the daemon still never holds a token: it drives the harness down an authenticated
 * path that invokes no model, and the harness rewrites its own store. So there is no flow, no window,
 * no verification URL and no return trip — which is why this is one request and one answer rather than
 * the five-route family a login needs.
 *
 * **THIS ENUM IS THE OWNER.** `packages/fleet/src/lib/token-refresh.ts` infers its own
 * `FleetTokenRefreshStatus` from it rather than restating it, because a wire projection narrower than
 * its domain turns a later domain outcome into a 500, and one wider promises a status nothing can
 * produce. Two spellings of one closed set is how those drift.
 *
 * The four that did nothing are four different reasons for having done nothing, and collapsing them is
 * how a report ends up implying a fleet renewed itself when part of it was never looked at:
 *
 * - `renewed` — the harness rotated it, and no browser was opened. The only success.
 * - `not-expired` — some home in this identity still holds a valid access token. A REFUSAL this product
 *   wants to be loud about: a rotating refresh token is spent by being used, so firing at a credential
 *   that needed nothing is the destructive case.
 * - `not-renewable` — there is no refresh token here to spend. This identity needs a person.
 * - `not-required` — it authenticates with a key, so there is no provider token to renew.
 * - `indeterminate` — a home could not be read, so nothing at all is known and nothing was fired.
 * - `unavailable` — the harness CLI this renewal needs is not installed on this host.
 * - `failed` — the path ran and the credential is still not valid.
 */
export const FleetRenewalStatusSchema = z.enum([
  'renewed',
  'not-expired',
  'not-renewable',
  'not-required',
  'indeterminate',
  'unavailable',
  'failed',
]);
export type FleetRenewalStatus = z.infer<typeof FleetRenewalStatusSchema>;

/**
 * What became of the code a sign-in handed out or took in, recognised as a STATE rather than forwarded
 * as text.
 *
 * - `rejected` — Claude refused the code a person brought back. Either it answered
 *   `Invalid code. Please make sure the full code was copied.` and kept waiting (a paste missing its
 *   `#state` half), or it exited after a code was sent (the provider would not exchange it). Both
 *   strings are in the installed CLI's own source (claude-code 2.1.281, `auth login`).
 * - `expired` — Codex's one-time code stopped being waited for before anybody approved it: the daemon's
 *   window closed, or Codex printed `device auth timed out after 15 minutes` (codex-cli 0.156.1). This is
 *   deliberately NOT `rejected`: a device grant takes no code back, so nothing here was refused. A
 *   Claude link whose window closed is `expired` for the same reason.
 *
 * No child output travels with either value — `docs/design/harness-login.md` §3.3 rule 2 forbids that,
 * and a recognised state needs none. They exist because without them a refused code and a code that
 * was never sent look identical: the form clears and nothing says which happened (§6).
 */
export const HarnessLoginLastCodeSchema = z.enum(['rejected', 'expired']);
export type HarnessLoginLastCode = z.infer<typeof HarnessLoginLastCodeSchema>;

/** Every flow state carries these, in every state, so a reader never has to ask which flow it holds. */
const flowShape = {
  flowId: NonEmptyStringSchema,
  /** The account-model credential being signed in. */
  loginId: LoginIdSchema,
  identity: NonEmptyStringSchema,
  startedAt: InstantSchema,
  /** When this flow is abandoned and its child killed. Bounded in minutes, never open-ended. */
  expiresAt: InstantSchema,
  /**
   * Set only on a START's answer, when the start picked up the sign-in already running for this
   * credential instead of launching a second one. A surface says so, and offers to start over.
   */
  resumed: z.literal(true).optional(),
};

/** Present in `failed` on both flows: what went wrong, and the host command that always works. */
const failureShape = {
  reason: NonEmptyStringSchema,
  /**
   * The way back, named at the point of failure.
   *
   * `fy login signin <id>` inherits a terminal and keeps working when every assumption this flow
   * makes about somebody else's CLI is false, so it is the fallback for the whole feature — and a
   * refusal that did not name it would strand the person who most needs it.
   */
  remedy: NonEmptyStringSchema,
  /**
   * Set when the flow ended BECAUSE of the code — refused, or no longer waited for — so a surface can say
   * so and offer a fresh one instead of a host command. Absent for every other failure.
   */
  lastCode: HarnessLoginLastCodeSchema.optional(),
  /**
   * Set when the harness's own login finished cleanly but the credential's store then held no usable
   * login. The login may simply have landed late, or somewhere the daemon could not read at that moment,
   * so a surface offers to LOOK AGAIN — a `{ method: 'recheck' }` submission, which re-reads the store
   * without signing in again. `reason` says which places were checked and what each held.
   */
  recheck: z.literal(true).optional(),
};

/**
 * Claude's own login, as a state machine.
 *
 * `awaiting-code` is where this flow differs from Codex's: Claude has no device grant, so the person
 * opens the URL, signs in, and the provider's hosted page shows them a code to bring back. There is no
 * localhost callback anywhere in this path.
 */
export const ClaudeLoginFlowSchema = z.discriminatedUnion('state', [
  z.strictObject({ harness: z.literal('claude-code'), ...flowShape, state: z.literal('starting') }),
  z.strictObject({
    harness: z.literal('claude-code'),
    ...flowShape,
    state: z.literal('awaiting-code'),
    verificationUrl: HarnessLoginVerificationUrlSchema,
    /**
     * Claude refused the last code and is waiting for another. Only `rejected` can happen here — a flow
     * still awaiting a code has not expired. Cleared by the next submission.
     */
    lastCode: HarnessLoginLastCodeSchema.extract(['rejected']).optional(),
  }),
  z.strictObject({ harness: z.literal('claude-code'), ...flowShape, state: z.literal('complete') }),
  z.strictObject({ harness: z.literal('claude-code'), ...flowShape, state: z.literal('failed'), ...failureShape }),
]);
export type ClaudeLoginFlow = z.infer<typeof ClaudeLoginFlowSchema>;

/**
 * Codex's own login, as a state machine — either of its two sign-ins.
 *
 * `awaiting-approval` carries BOTH values the provider prints, because a device grant needs both: the
 * URL to open and the code to type there. There is no submission — the child polls the provider and
 * exits on its own, so this flow has nothing for a person to bring back.
 *
 * `awaiting-callback` is the LINK sign-in: `verificationUrl` is the provider's authorize page, and
 * the person brings back the address their browser was sent to afterwards. `finishing` is the moment
 * after that address reached Codex, while Codex redeems it with the provider. The address itself is
 * never on the wire, in either state.
 */
export const CodexLoginFlowSchema = z.discriminatedUnion('state', [
  z.strictObject({ harness: z.literal('codex'), ...flowShape, state: z.literal('starting') }),
  z.strictObject({
    harness: z.literal('codex'),
    ...flowShape,
    state: z.literal('awaiting-approval'),
    verificationUrl: HarnessLoginVerificationUrlSchema,
    userCode: HarnessLoginUserCodeSchema,
  }),
  z.strictObject({
    harness: z.literal('codex'),
    ...flowShape,
    state: z.literal('awaiting-callback'),
    verificationUrl: HarnessLoginVerificationUrlSchema,
    /**
     * Codex said device-code sign-in is not available for this account, so the daemon moved this flow to
     * the link sign-in by itself. Set only then, so a surface can say why the screen changed.
     */
    deviceCode: z.literal('unavailable').optional(),
  }),
  z.strictObject({ harness: z.literal('codex'), ...flowShape, state: z.literal('finishing') }),
  z.strictObject({ harness: z.literal('codex'), ...flowShape, state: z.literal('complete') }),
  z.strictObject({ harness: z.literal('codex'), ...flowShape, state: z.literal('failed'), ...failureShape }),
]);
export type CodexLoginFlow = z.infer<typeof CodexLoginFlowSchema>;

/**
 * The transport union, so one route can answer for either harness.
 *
 * A plain union rather than a third discriminated union over `harness`: the two members are already
 * disjoint on that field, and nesting one discriminated union inside another would make the schema's
 * shape depend on how a library flattens discriminators. A reader narrows on `harness` and then holds
 * exactly one harness's own state union — never a merged one.
 */
export const HarnessLoginFlowSchema = z.union([ClaudeLoginFlowSchema, CodexLoginFlowSchema]);
export type HarnessLoginFlow = z.infer<typeof HarnessLoginFlowSchema>;

/**
 * How a Codex sign-in is done. Claude has one way, so this applies to Codex alone.
 *
 * - `device-code` — the default. A link and a one-time code typed AT the provider; nothing comes back.
 * - `link` — Codex's own browser login. The provider sends the browser to a `localhost` address on
 *   the host, which a phone cannot load, and the person pastes that address back. It exists because an
 *   account or workspace can turn device codes off, and then this is the only way in from a browser.
 */
export const HarnessLoginCodexMethodSchema = z.enum(['device-code', 'link']);
export type HarnessLoginCodexMethod = z.infer<typeof HarnessLoginCodexMethodSchema>;

/** Start one login. The caller names a CREDENTIAL — never a command, never a path. */
export const HarnessLoginStartRequestSchema = z.strictObject({
  /**
   * The account-model credential to sign in (design §4.6, §7): every runtime on it, or none yet — an
   * empty slot is signed in before anything uses it.
   */
  loginId: LoginIdSchema,
  /** Codex only: which of its two sign-ins to run. Absent means a device code. */
  method: HarnessLoginCodexMethodSchema.optional(),
  /**
   * Start over. A credential has at most one running sign-in, and a start without this picks that one
   * up (`resumed`). With it, the running one is ended — its child killed and waited for, so a Codex
   * link frees the machine's callback port — and a fresh one starts in its place.
   */
  restart: z.literal(true).optional(),
});
export type HarnessLoginStartRequest = z.infer<typeof HarnessLoginStartRequestSchema>;

/**
 * The one value a person brings back: Claude's code, or the address a Codex link sign-in ended on.
 *
 * WRITE-ONLY AND SINGLE-USE. It is written to the harness child's stdin and retained nowhere: not in a
 * status, not in an error message, not in a log line, not in the grant audit journal. Non-retention is
 * the protection, not redaction — the secrets redactor masks values the vault holds, and this value is
 * never stored anywhere for it to mask.
 *
 * Bounded generously rather than shape-checked: what a provider's hosted page shows a person is that
 * provider's business and has already changed once. A bound stops an unbounded body; a pattern would
 * refuse a legitimate code the day the format moves.
 */
const HarnessLoginCodeSubmitSchema = z.strictObject({
  code: z.string().min(1).max(4_096),
});

/**
 * What a person can send to a sign-in: the value they brought back, or — for a Codex device code that did
 * not work — "use a link instead", or — for a sign-in that ended {@link failureShape} `recheck` — "look
 * for the login again", which reads the credential's store once more and launches nothing. Each rides the
 * same request because it is the same consent: the step-up this sign-in was started under covers the
 * credential, not the method.
 */
export const HarnessLoginSubmitRequestSchema = z.union([
  HarnessLoginCodeSubmitSchema,
  z.strictObject({ method: z.literal('link') }),
  z.strictObject({ method: z.literal('recheck') }),
]);
export type HarnessLoginSubmitRequest = z.infer<typeof HarnessLoginSubmitRequestSchema>;

/**
 * What a submission did, in four outcomes that are four different next actions.
 *
 * Modelled on `POST /v1/sessions/:sessionId/answer`, and `unconfirmed` is the member that matters
 * most: "nobody can say whether that code reached the child" is a real outcome — the child may have
 * exited between the write and the read — and reporting it as a failure would invite a retry that
 * cannot help, while reporting it as success would claim something nobody knows.
 *
 * `refused` is also the answer a Codex flow always gives, because Codex has no return trip. That is
 * information rather than an error: the person should be typing the code at the provider, not here.
 */
export const HarnessLoginSubmissionSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('accepted'), flow: HarnessLoginFlowSchema }),
  z.strictObject({ outcome: z.literal('refused'), reason: NonEmptyStringSchema }),
  z.strictObject({ outcome: z.literal('conflict'), reason: NonEmptyStringSchema }),
  z.strictObject({ outcome: z.literal('unconfirmed'), reason: NonEmptyStringSchema }),
]);
export type HarnessLoginSubmission = z.infer<typeof HarnessLoginSubmissionSchema>;

// ── Model catalogs (docs/model-catalog.md) ────────────────────────────────────────────────────────────────

export const ModelTierSchema = z.enum(['best', 'balanced', 'fast']);

export const ModelCatalogEntryViewSchema = z.strictObject({
  /** The value a CLI is handed (with a context suffix, when the catalog gives one). */
  id: NonEmpty,
  label: NonEmpty,
  tier: ModelTierSchema,
  context: z.number().int().positive().optional(),
  efforts: z.array(NonEmpty).readonly(),
  default: z.boolean(),
  /** The catalog's one sentence about it, when it has one. */
  note: NonEmpty.optional(),
  /** List price, USD per million input and output tokens, when the catalog states one. */
  price: z.strictObject({ input: z.number().finite().min(0), output: z.number().finite().min(0) }).optional(),
  /** The day (YYYY-MM-DD) its provider retires it, when the catalog says. */
  retires: NonEmpty.optional(),
});
export type ModelCatalogEntryView = z.infer<typeof ModelCatalogEntryViewSchema>;

export const ModelCatalogViewSchema = z.strictObject({
  id: NonEmpty,
  label: NonEmpty,
  /** Which copy is in effect: this machine's own file, the published catalog, or this build's. */
  origin: z.enum(['file', 'published', 'built-in']),
  verified: NonEmpty,
  customIds: z.boolean(),
  claude: z.array(ModelCatalogEntryViewSchema).readonly().optional(),
  codex: z.array(ModelCatalogEntryViewSchema).readonly().optional(),
});
export type ModelCatalogView = z.infer<typeof ModelCatalogViewSchema>;

/** What one check for a newer published catalog came to. */
export const ModelCatalogRefreshOutcomeSchema = z.enum([
  /** A different version was published, checked and is now in effect. */
  'updated',
  /** The published version is the one this machine already holds: nothing was downloaded. */
  'unchanged',
  /** The last check was recent; nothing was asked. */
  'not-due',
  /** The published catalog could not be reached; the one held stays in effect. */
  'unreachable',
  /** What was published did not check — signature, hash or shape; the one held stays in effect. */
  'refused',
  /** This daemon follows no published catalog (`FY_MODEL_CATALOG=off`). */
  'disabled',
]);
export type ModelCatalogRefreshOutcome = z.infer<typeof ModelCatalogRefreshOutcomeSchema>;

export const ModelCatalogRefreshResultSchema = z.strictObject({
  outcome: ModelCatalogRefreshOutcomeSchema,
  /** The published version in effect after the check, when there is one. */
  version: z.number().int().nonnegative().optional(),
  /** Why, in one sentence, for `unreachable` and `refused`. */
  reason: NonEmpty.optional(),
});
export type ModelCatalogRefreshResult = z.infer<typeof ModelCatalogRefreshResultSchema>;

export const ModelCatalogsViewSchema = z.strictObject({
  published: z.strictObject({
    /** The hosted app's origin the published catalog is read from. */
    origin: NonEmpty,
    enabled: z.boolean(),
    version: z.number().int().nonnegative().optional(),
    fetchedAt: InstantSchema.optional(),
    checkedAt: InstantSchema.optional(),
    last: ModelCatalogRefreshResultSchema.optional(),
  }),
  catalogs: z.array(ModelCatalogViewSchema).readonly(),
});
export type ModelCatalogsView = z.infer<typeof ModelCatalogsViewSchema>;

// ── Models installed on this machine ─────────────────────────────────────────────────────────────

/**
 * What the last read of the local server found. `not-running` and `unreadable` are the two ways a
 * server that should be there is not usable; `refused` is an address that is not this machine's;
 * `disabled` is a daemon told to read none (`FY_LOCAL_MODELS=off`).
 */
export const LocalModelsStateSchema = z.enum([
  'found',
  'none-pulled',
  'not-running',
  'unreadable',
  'refused',
  'disabled',
]);
export type LocalModelsState = z.infer<typeof LocalModelsStateSchema>;

/** One model the local server has installed. The id is what the CLI is handed (`gpt-oss:20b`). */
export const LocalModelSchema = z.strictObject({
  id: NonEmpty,
  label: NonEmpty,
  sizeBytes: z.number().int().nonnegative().optional(),
  parameterSize: NonEmpty.optional(),
  quantization: NonEmpty.optional(),
  family: NonEmpty.optional(),
  modifiedAt: InstantSchema.optional(),
});
export type LocalModel = z.infer<typeof LocalModelSchema>;

export const LocalModelsSchema = z.strictObject({
  provider: z.literal('ollama'),
  /** The address that was read, without a trailing slash. */
  baseUrl: NonEmpty,
  state: LocalModelsStateSchema,
  models: z.array(LocalModelSchema).readonly(),
  checkedAt: InstantSchema,
  /** One sentence a person can act on, for every state. */
  message: NonEmpty,
  /** The exact command that installs a model, e.g. `ollama pull gpt-oss:20b`. */
  pullCommand: NonEmpty,
});
export type LocalModels = z.infer<typeof LocalModelsSchema>;

// ── Config files (§9.2): `logins/<id>.yaml`, `endpoints/<id>.yaml`, `models/<name>.yaml` ──────────────────────────
//
// COPIED from today's `packages/fleet/src/lib/account/{schema,budget,disabled,environment}.ts`,
// `presets/schema.ts` and `models/schema.ts`. PARTIAL, on purpose and declared: the cross-field `.check()` rules
// (halves must name a usable half, a Codex provider's key variable must be one of the login's `env`, a catalog has
// exactly one default model, anthropic prices state both cache-write lifetimes, a preset's test key variable must be a
// secret) are logic, not shape; the port brings them across with the schemas it writes tests for. The kernel's config
// layer separately refuses a raw secret in any file, so `env` values here are plain strings that may hold
// `${secret:NAME}`.

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/u;
const Text = z.string().min(1).max(600);

/** A login's id: the file name under `logins/`. Same grammar as {@link LoginIdSchema}. */
export const LOGIN_NAME = /^[a-z0-9][a-z0-9-]*$/u;

/** Switched off without deleting it (docs/disabling.md): `until` is an instant or a calendar date. */
export const LoginDisabledFileSchema = z.strictObject({
  reason: z.string().trim().min(1).max(200).optional(),
  until: z
    .string()
    .refine(
      value => z.iso.datetime({ offset: true }).safeParse(value).success || z.iso.date().safeParse(value).success,
      {
        message: 'write "until" as a date (2026-11-01) or a time (2026-11-01T09:00:00Z)',
      },
    )
    .optional(),
});
export type LoginDisabledFile = z.infer<typeof LoginDisabledFileSchema>;

const BudgetAmountSchema = z.number().finite().positive();

/** One budget period's two levels. Either may be left out; the hard one is not below the trigger. */
export const BudgetLimitSchema = z
  .strictObject({ trigger: BudgetAmountSchema.optional(), hard: BudgetAmountSchema.optional() })
  .refine(limit => limit.trigger !== undefined || limit.hard !== undefined, {
    message: 'a budget period needs a "trigger", a "hard" limit, or both',
  })
  .refine(limit => limit.trigger === undefined || limit.hard === undefined || limit.hard >= limit.trigger, {
    message: 'the hard limit must not be below the trigger',
  });
export type BudgetLimit = z.infer<typeof BudgetLimitSchema>;

/** A daily and/or weekly spend budget in US dollars (docs/budgets.md). */
export const BudgetSchema = z
  .strictObject({ daily: BudgetLimitSchema.optional(), weekly: BudgetLimitSchema.optional() })
  .refine(budget => budget.daily !== undefined || budget.weekly !== undefined, {
    message: 'a budget needs a "daily" or a "weekly" limit; remove "budget" to have none',
  });
export type Budget = z.infer<typeof BudgetSchema>;
export const BUDGET_PERIODS = ['daily', 'weekly'] as const;

/** The Codex model provider an environment login points Codex at. */
export const CodexProviderSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/u, 'use lowercase letters, digits, dashes and underscores'),
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().min(1).max(512).optional(),
  keyVariable: EnvNameSchema.optional(),
  model: z.string().min(1).max(120).optional(),
  queryParams: z.record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/u), z.string().max(200)).optional(),
});

/** `aws-profile:<name>`, `gcloud-adc`, `gcloud-adc:<path>` or `azure-cli`: a reference, never a copy. */
export const CloudCredentialReferenceSchema = z
  .string()
  .regex(/^(aws-profile:.+|gcloud-adc(:.+)?|azure-cli)$/u, 'aws-profile:<profile>, gcloud-adc[:<path>] or azure-cli');

/** One harness's half of an environment login. */
export const LoginHalfSchema = z.strictObject({
  env: LoginEnvSchema.default({}),
  codexProvider: CodexProviderSchema.optional(),
});

/** How a login is kept: the host's own sign-in, Ferretry's own copy of a harness login, or environment variables. */
export const LoginStoreFileSchema = z.enum(['host', 'ferretry', 'environment']);

/** `config/logins/<id>.yaml`. A secret travels as `${secret:NAME}`, never a value. */
export const LoginFileSchema = z.strictObject({
  harness: HarnessKindSchema,
  store: LoginStoreFileSchema.default('ferretry'),
  label: z.string().min(1).optional(),
  clonedFrom: z.string().min(1).optional(),
  clonedFromDaemon: z.string().min(1).optional(),
  clonedFromKey: z.string().min(1).optional(),
  disabled: LoginDisabledFileSchema.optional(),
  budget: BudgetSchema.optional(),
  env: LoginEnvSchema.optional(),
  preset: z.string().min(1).max(64).optional(),
  cloudCredential: CloudCredentialReferenceSchema.optional(),
  codexProvider: CodexProviderSchema.optional(),
  claude: LoginHalfSchema.optional(),
  codex: LoginHalfSchema.optional(),
});
export type LoginFile = z.infer<typeof LoginFileSchema>;

/**
 * An environment login's own variables as Runtimes reads them to build a runtime's home (`LoginsApi.environmentTemplates`):
 * the login file's variable TEMPLATES, exactly as written. A value is plain text or contains `${secret:NAME}` references;
 * the file schema refuses a raw secret, so no value of a secret is here to be read, and nothing else of the file travels
 * (not its budget, not its text).
 */
export const EnvironmentLoginTemplateSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('templates'),
    id: z.string().min(1),
    harness: HarnessKindSchema,
    env: LoginEnvSchema.optional(),
    preset: z.string().min(1).max(64).optional(),
    cloudCredential: CloudCredentialReferenceSchema.optional(),
    codexProvider: CodexProviderSchema.optional(),
    claude: LoginHalfSchema.optional(),
    codex: LoginHalfSchema.optional(),
  }),
  /**
   * A login whose file is not a clean, checked version in effect (it is invalid, a loosening edit of it is held, or a
   * variable holds something that looks like a raw secret): its NAME and its variable NAMES only, never a value.
   */
  z.strictObject({
    kind: z.literal('withheld'),
    id: z.string().min(1),
    harness: HarnessKindSchema,
    variables: z.array(z.string().min(1)).readonly(),
  }),
]);
export type EnvironmentLoginTemplate = z.infer<typeof EnvironmentLoginTemplateSchema>;

const PresetVariableFileSchema = z
  .strictObject({
    value: z.string().max(1024).optional(),
    /** The secret's suggested NAME in the store; the login holds `${secret:NAME}`. */
    secretName: z.string().min(1).max(100).optional(),
    required: z.boolean().default(true),
    allowEmpty: z.boolean().default(false),
    description: Text.optional(),
  })
  .refine(variable => (variable.value === undefined) !== (variable.secretName === undefined), {
    message: 'a preset variable is exactly one of "value" or "secretName"',
  });

const ProbeShape = {
  url: z.string().min(1).max(512),
  keyVariable: EnvNameSchema,
  header: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/u)
    .default('authorization'),
  scheme: z.string().max(32).default('Bearer'),
  headers: z.record(z.string().regex(/^[a-z0-9-]{1,64}$/u), z.string().max(200)).default({}),
  note: Text,
};

/** How a login made from the preset is tested: a free read, one capped inference with consent, a local read, or none. */
export const PresetTestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), ...ProbeShape }),
  z.strictObject({ kind: z.literal('inference'), ...ProbeShape, body: z.string().min(2).max(2048) }),
  z.strictObject({ kind: z.literal('local'), url: z.string().min(1).max(512), note: Text }),
  z.strictObject({ kind: z.literal('none'), reason: Text }),
]);

const PresetHalfFileSchema = z.strictObject({
  docs: z.url().optional(),
  env: z.record(EnvNameSchema, PresetVariableFileSchema).default({}),
  codexProvider: CodexProviderSchema.optional(),
  models: z.array(z.string().min(1).max(120)).default([]),
  unavailable: Text.optional(),
});

/** `config/endpoints/<id>.yaml`: a provider preset as data, so an OpenAI- or Anthropic-style endpoint needs no code (§4.4). */
export const EndpointFileSchema = z.strictObject({
  label: z.string().min(1).max(80),
  summary: Text,
  group: PresetGroupSchema.optional(),
  docs: z.url(),
  verified: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }),
  unverified: z.array(Text).default([]),
  harness: HarnessKindSchema.optional(),
  env: z.record(EnvNameSchema, PresetVariableFileSchema).optional(),
  codexProvider: CodexProviderSchema.optional(),
  models: z.array(z.string().min(1).max(120)).optional(),
  claude: PresetHalfFileSchema.optional(),
  codex: PresetHalfFileSchema.optional(),
  cloudCredential: z
    .strictObject({ kinds: z.array(CloudCredentialKindSchema).min(1), suggested: z.string().min(1) })
    .optional(),
  test: PresetTestSchema,
  quota: z.strictObject({ source: ProviderQuotaSourceSchema, note: Text }),
  catalog: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u)
    .optional(),
  pricing: z.string().min(1).max(64).optional(),
  unavailable: Text.optional(),
  detect: z
    .strictObject({
      hosts: z.array(z.string().min(1)).default([]),
      variables: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*\*?$/u)).default([]),
      keyPrefixes: z.array(z.string().regex(/^[A-Za-z0-9_-]{3,24}$/u)).default([]),
    })
    .optional(),
});
export type EndpointFile = z.infer<typeof EndpointFileSchema>;

/** A model id as a CLI is handed it. */
export const ModelIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}$/u, 'letters, digits and . _ : ~ / @ + -, without spaces');

const UsdPerMillionSchema = z.number().nonnegative().max(10_000);
const EffortSchema = z.string().regex(/^[a-z]{2,12}$/u);

/** List price in dollars per million tokens, as today's catalog states it (cache-write rules are the port's). */
export const CatalogPriceSchema = z.strictObject({
  provider: z.enum(['openai', 'anthropic', 'deepseek', 'moonshot', 'zai', 'minimax', 'alibaba']),
  input: UsdPerMillionSchema,
  output: UsdPerMillionSchema,
  cacheRead: UsdPerMillionSchema,
  cacheWrite: UsdPerMillionSchema.optional(),
  cacheWrite5m: UsdPerMillionSchema.optional(),
  cacheWrite1h: UsdPerMillionSchema.optional(),
  reasoning: UsdPerMillionSchema.optional(),
  source: z.url(),
  verified: z.string().regex(YYYY_MM_DD),
});

export const CatalogModelSchema = z.strictObject({
  id: ModelIdSchema,
  label: z.string().min(1).max(80),
  tier: ModelTierSchema,
  suffix: z
    .string()
    .regex(/^\[[a-z0-9]{1,8}\]$/u)
    .optional(),
  context: z.number().int().positive().max(100_000_000).optional(),
  reasoning: z.boolean().optional(),
  efforts: z.array(EffortSchema).default([]),
  defaultEffort: EffortSchema.optional(),
  default: z.boolean().default(false),
  note: Text.optional(),
  price: CatalogPriceSchema.optional(),
  retires: z.string().regex(YYYY_MM_DD).optional(),
});

const SlotValueSchema = z.string().regex(/^[A-Za-z0-9~][A-Za-z0-9._:~/@+-]{0,159}(?:\[[a-z0-9]{1,8}\])?$/u);

const CatalogHalfFileSchema = z.strictObject({
  docs: z.url().optional(),
  /** Claude Code's tier slots (opus, sonnet, haiku, subagent). */
  tiers: z
    .strictObject({
      opus: SlotValueSchema.optional(),
      sonnet: SlotValueSchema.optional(),
      haiku: SlotValueSchema.optional(),
      subagent: SlotValueSchema.optional(),
    })
    .optional(),
  models: z.array(CatalogModelSchema).min(1),
});

/** `config/models/<name>.yaml`: a model catalog a login offers. */
export const ModelCatalogFileSchema = z.strictObject({
  label: z.string().min(1).max(80),
  docs: z.url(),
  verified: z.string().regex(YYYY_MM_DD, { message: 'write the date as YYYY-MM-DD' }),
  unverified: z.array(Text).default([]),
  customIds: z.boolean().default(false),
  detect: z.enum(['ollama']).optional(),
  claude: CatalogHalfFileSchema.optional(),
  codex: CatalogHalfFileSchema.optional(),
});
export type ModelCatalogFile = z.infer<typeof ModelCatalogFileSchema>;

// ── State (state/logins/models.json) ─────────────────────────────────────────────────────────────────────────────

/** What the last published-catalog check and local-model read left behind. Never a credential. */
export const ModelsStateSchema = z.strictObject({
  format: z.literal(1),
  published: z
    .strictObject({
      version: z.number().int().nonnegative(),
      fetchedAt: InstantSchema,
      checkedAt: InstantSchema,
      catalog: z.unknown(),
    })
    .optional(),
  local: LocalModelsSchema.optional(),
});
export type ModelsState = z.infer<typeof ModelsStateSchema>;
