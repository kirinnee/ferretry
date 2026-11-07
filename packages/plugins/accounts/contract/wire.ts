/**
 * Accounts' wire (§2.1): the ids, places and views other subsystems and the app read, copied field for field from
 * today's `packages/protocol/src/lib/{account-ids,accounts,login-entries,secure-copy,agenda}.ts`. The full route body
 * schemas (sign-ins, 2FA keys, recipes, rules, copy plans, task plans) are copied by the port with the code that
 * answers them.
 *
 * NO SAVED VALUE CROSSES THIS WIRE. A password or 2FA seed is sealed in the Vault under a sealed name and is typed by
 * the Vault into a verified target; Accounts holds the index, never the value.
 */
import { SignInRuleStageIdSchema, TaskPlanStageIdSchema, TwoFactorStageIdSchema } from '@ferretry/core-gate/contract';
import { SecretNameSchema } from '@ferretry/core-vault/contract';
import { z } from 'zod';
import { LoginRecipeProposalIdSchema } from './routes/login-recipes.ts';

export { SignInRuleStageIdSchema, TaskPlanStageIdSchema, TwoFactorStageIdSchema };

// ─── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** An account's handle is a secret-store name: uppercase letters, digits and underscores. */
export const AccountIdSchema = SecretNameSchema;
export type AccountId = z.infer<typeof AccountIdSchema>;

export const AccountKeySchema = z.string().regex(/^L[0-9A-F]{24}$/u, 'an account key is L and 24 hex digits');
export type AccountKey = z.infer<typeof AccountKeySchema>;

export const SignInIdSchema = z.string().regex(/^si_[0-9a-f]{16}$/u, 'a sign-in id is si_ and 16 hex digits');
export type SignInId = z.infer<typeof SignInIdSchema>;

export const TwoFactorIdSchema = z.string().regex(/^tf_[0-9a-f]{12}$/u, 'a 2FA key id is tf_ and 12 hex digits');
export type TwoFactorId = z.infer<typeof TwoFactorIdSchema>;

export const SignInRuleIdSchema = z
  .string()
  .regex(/^sr_[0-9a-f]{24}$/u, 'a standing sign-in rule is sr_ and 24 hex digits');
export type SignInRuleId = z.infer<typeof SignInRuleIdSchema>;

export const SignInRuleSuggestionIdSchema = z
  .string()
  .regex(/^srg_[0-9a-f]{16}$/u, 'a standing rule suggestion is srg_ and 16 hex digits');

export const SignInRuleRevisionSchema = z.number().int().min(1).max(1_000_000);

/** The sealed name a saved value lives under in the Vault: never the value. */
export const SealedNameSchema = z.string().regex(/^L[0-9A-F]{24}_(?:PASSWORD|TOTP)_[0-9A-F]{8}$/u);

export const PhoneApprovalIdSchema = z
  .string()
  .regex(/^pa_[0-9a-f]{24}$/u, 'a phone approval id is pa_ and 24 hex digits');
export const PlanIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);

// ─── places ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_LOGIN_ENTRIES = 256;
export const MAX_ACCOUNTS = MAX_LOGIN_ENTRIES;
export const MAX_SIGN_INS = 512;
export const MAX_SIGN_INS_PER_ACCOUNT = 16;
export const LOGIN_MATCH_MAX = 16;
export const SIGN_IN_PROJECT_MAX_LENGTH = 128;

/** A program@host or a web host, lowercase: the key a sign-in is matched on. */
export const LoginMatchSchema = z
  .string()
  .max(320)
  .regex(
    /^(?:[a-z0-9][a-z0-9._+-]{0,63}@)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u,
    'a program@host or a web host, lowercase',
  );
export type LoginMatch = z.infer<typeof LoginMatchSchema>;

export const LoginDomainSchema = z
  .string()
  .max(260)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u, 'a web host, lowercase, like app.vercel.com');
export type LoginDomain = z.infer<typeof LoginDomainSchema>;

export const PlaceKeySchema = LoginMatchSchema;
export type PlaceKey = LoginMatch;

export const SitePlaceSchema = z
  .strictObject({
    kind: z.literal('site'),
    domains: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
    match: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
  })
  .refine(place => place.domains.length + place.match.length > 0, 'a site sign-in names at least one host');
export type SitePlace = z.infer<typeof SitePlaceSchema>;

export const REMOTE_TOOLS = ['ssh', 'scp', 'sftp'] as const;
const isRemoteTool = (tool: string): boolean => (REMOTE_TOOLS as readonly string[]).includes(tool);

/** The key a terminal sign-in is matched on: `tool@dest` for ssh/scp/sftp, else `tool@host`. */
export function terminalKey(place: {
  readonly tool: string;
  readonly host: string;
  readonly dest?: string | undefined;
}): string {
  return `${place.tool}@${place.dest ?? place.host}`;
}

export const TerminalPlaceSchema = z
  .strictObject({
    kind: z.literal('terminal'),
    tool: z.string().regex(/^[a-z0-9][a-z0-9._+-]{0,63}$/u, 'a program name, lowercase'),
    host: LoginDomainSchema,
    dest: LoginDomainSchema.optional(),
  })
  .refine(place => place.dest === undefined || isRemoteTool(place.tool), {
    path: ['dest'],
    message: 'only ssh, scp and sftp have a destination',
  })
  .refine(place => place.dest !== undefined || !isRemoteTool(place.tool), {
    path: ['dest'],
    message: 'ssh, scp and sftp name their destination',
  })
  .refine(place => LoginMatchSchema.safeParse(terminalKey(place)).success, {
    message: 'the program and host are too long to be a terminal key',
  });
export type TerminalPlace = z.infer<typeof TerminalPlaceSchema>;

export const PlaceSchema = z.discriminatedUnion('kind', [SitePlaceSchema, TerminalPlaceSchema]);
export type Place = z.infer<typeof PlaceSchema>;

// ─── secure copy ──────────────────────────────────────────────────────────────────────────────────────────────────

export const COPY_HANDLE_PREFIX = 'sealed:';
export const COPY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;

export const CopyNameSchema = z
  .string()
  .regex(COPY_NAME_PATTERN, 'a copy name is a lowercase letter, then up to 39 lowercase letters, digits, _ or -');
export type CopyName = z.infer<typeof CopyNameSchema>;

/** A copy's name, with or without its `sealed:` prefix. */
export const CopyHandleSchema = z
  .string()
  .trim()
  .transform(value => (value.startsWith(COPY_HANDLE_PREFIX) ? value.slice(COPY_HANDLE_PREFIX.length) : value))
  .pipe(CopyNameSchema);

// ─── the `sign-in-approval` ask source ────────────────────────────────────────────────────────────────────────────

/**
 * What a sign-in approval card names, from today's agenda refs: a task plan or copy plan (answered by the plan's
 * own routes, with a passkey), a ferret's rule suggestion (opens the create sheet with NOTHING ticked), a suspended
 * rule, an approve-on-phone push, or a staged 2FA seed. Each names an id only, never an account or a value; Asks' generic answer
 * creates nothing. Only the daemon raises one.
 */
export const SignInApprovalRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('task-plan'), planId: PlanIdSchema }),
  z.strictObject({ kind: z.literal('copy-plan'), planId: PlanIdSchema }),
  z.strictObject({ kind: z.literal('rule-suggestion'), suggestion: SignInRuleSuggestionIdSchema }),
  z.strictObject({ kind: z.literal('rule-suspended'), rule: SignInRuleIdSchema }),
  z.strictObject({ kind: z.literal('phone-approval'), id: PhoneApprovalIdSchema }),
  z.strictObject({ kind: z.literal('recipe-proposal'), signIn: SignInIdSchema, proposal: LoginRecipeProposalIdSchema }),
  /** A staged 2FA seed waiting for the owner's passkey (S101): the stage alone, never the account. */
  z.strictObject({ kind: z.literal('two-factor-seed'), stage: TwoFactorStageIdSchema }),
]);
export type SignInApprovalRef = z.infer<typeof SignInApprovalRefSchema>;

// ─── config/accounts.yaml (today's config/account-defaults.yaml) ─────────────────────────────────────────────────

const hasDotSegment = (path: string): boolean => path.split('/').some(segment => segment === '.' || segment === '..');

const DefaultsMapSchema = z
  .record(PlaceKeySchema, AccountIdSchema)
  .refine(map => Object.keys(map).length <= MAX_ACCOUNTS, `at most ${String(MAX_ACCOUNTS)} lines`);

/**
 * WHICH ACCOUNT A SIGN-IN CARD OFFERS FIRST, as the owner wrote it. It orders buttons only: the owner's tap is still
 * the permission, and a line can only choose among the sign-ins the daemon matched. So no edit loosens anything.
 */
export const AccountsConfigSchema = z.strictObject({
  /** Machine-wide: the starred account per key. */
  sites: DefaultsMapSchema.optional(),
  /** Per board project, by its id or its exact name. */
  projects: z
    .record(
      z
        .string()
        .min(1)
        .max(SIGN_IN_PROJECT_MAX_LENGTH)
        .regex(/^\S(?:.*\S)?$/u),
      DefaultsMapSchema,
    )
    .optional(),
  /** For a ferret on the Unfiled board: by its working directory, absolute or `~/…`, the longest prefix wins. */
  folders: z
    .record(
      z
        .string()
        .min(1)
        .max(1_024)
        .regex(/^(?:~|~\/[^\p{Cc}]*|\/[^\p{Cc}]*)$/u, 'an absolute path or ~/…')
        .refine(line => !hasDotSegment(line), 'a folder path has no . or .. segment'),
      DefaultsMapSchema,
    )
    .optional(),
});
export type AccountsConfig = z.infer<typeof AccountsConfigSchema>;

// ─── the read model other plugins see ─────────────────────────────────────────────────────────────────────────────

/** One sign-in, as anything but Accounts may see it: where it is for and which account, never a value. */
export const SignInSummarySchema = z.strictObject({
  id: SignInIdSchema,
  account: AccountIdSchema,
  place: PlaceSchema,
});
export type SignInSummary = z.infer<typeof SignInSummarySchema>;
