/**
 * The wire contract for a harness login the UI drives — and for the reads that decide whether one
 * applies at all.
 *
 * ## What crosses this boundary, and what deliberately never does
 *
 * | value                         | on the wire? | why                                                          |
 * | ----------------------------- | ------------ | ------------------------------------------------------------ |
 * | a verification URL            | out          | anybody may open it; completing it binds THEIR account       |
 * | a Codex user code             | out          | same — it authorises nothing on its own                      |
 * | a credential CLASSIFICATION   | out          | `valid` / `refreshable` / `missing` / `unreadable`, no bytes  |
 * | one authorization code        | **in only**  | written straight to the harness child's stdin and dropped     |
 * | an access or refresh token    | **never**    | the harness writes its own store; the daemon never holds one  |
 *
 * There is no field here that could carry a token in either direction. `docs/secrets.md:38-42` states
 * that no route, command or API returns a secret value and that the property is enforced by the types
 * rather than by a check; this file is where that enforcement lives for this feature.
 * `docs/design/harness-login.md` §3.2 is the argument, and §3.3 rule 1 is why
 * `codex login --with-api-key` and `--with-access-token` appear nowhere in this contract.
 *
 * ## TWO FLOWS, NOT ONE
 *
 * {@link ClaudeLoginFlowSchema} and {@link CodexLoginFlowSchema} are separate schemas with separate
 * state unions, and they are separate because the two logins are separate programs:
 *
 * - **Claude** prints an authorization URL and reads a pasted code from stdin, so it has an
 *   `awaiting-code` state and a submission.
 * - **Codex** completes a device grant at the provider, so it has an `awaiting-approval` state, a user
 *   code to type there, and **no return trip at all**.
 *
 * A single parameterised flow would have needed an optional `userCode` and an optional submission on
 * both, which is a shape that can express a Codex flow waiting for a paste and a Claude flow with a
 * device code — two states neither harness has. {@link HarnessLoginFlowSchema} is the transport union
 * over the two, not a third flow: a reader narrows on `harness` first and then holds exactly one
 * harness's own states.
 *
 * Both were established by running the installed CLIs with piped stdio rather than by reading their
 * `--help` — see `docs/migration/surveys/harness-login-flows.md`.
 */
import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema } from './common.ts';
import { OperatorPasswordSchema } from './grants.ts';
import { SecretNameSchema } from './secrets.ts';

const AccountIdSchema = z.uuid();
const HarnessKindSchema = z.enum(['claude', 'codex']);
const AccountModeSchema = z.enum(['interactive', 'auto']);

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
 * Where one account's provider credential comes from.
 *
 * This is what decides whether a login applies, and it is on the wire so a surface can SAY where the
 * credential comes from instead of greying a control out. A control that cannot succeed with no
 * explanation reads as a broken product; `docs/grants.md:151-184` is the same rule for capabilities.
 *
 * `undeclared` is the fail-closed member: the account authenticates with a key and its configuration
 * says nowhere the key comes from. It is not `interactive-login` (which would offer a login for an
 * API-key account) and not `environment` (which would name a variable nobody declared).
 *
 * `secret-store` is the "no login wanted" answer and it is NOT `environment`, which is what it used to
 * be narrowed to. Both are true of a profiled account — the daemon does put the value into the
 * environment the wrapper is launched with — but they send a reader to two different places: one to a
 * variable they are supposed to set themselves, the other to `fy secret set` and Ferretry's own store.
 * It carries the secret NAMES because a person whose account cannot start needs to know which secret
 * is missing, and a name is not a value: no schema in this package has anywhere to put one.
 */
export const FleetCredentialSourceSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('interactive-login') }),
  z.strictObject({
    source: z.literal('secret-store'),
    variable: NonEmptyStringSchema,
    secrets: z.array(SecretNameSchema).min(1).readonly(),
  }),
  z.strictObject({
    source: z.literal('token-file'),
    variable: NonEmptyStringSchema,
    /** The shell file the generated wrapper sources. A path, never its contents. */
    path: NonEmptyStringSchema,
  }),
  z.strictObject({ source: z.literal('environment'), variable: NonEmptyStringSchema }),
  z.strictObject({ source: z.literal('configured-value'), variable: NonEmptyStringSchema }),
  z.strictObject({ source: z.literal('undeclared') }),
]);
export type FleetCredentialSource = z.infer<typeof FleetCredentialSourceSchema>;

/**
 * Whether a login applies to this account, and which rule refused when it does not.
 *
 * The two refusals are kept apart because they send a reader to two different places: a harness with
 * no interactive login is a fact about the tool, and a credential that is not a login is a fact about
 * this account — answered by the {@link FleetCredentialSourceSchema} travelling beside it.
 */
export const FleetLoginApplicabilitySchema = z.discriminatedUnion('applies', [
  z.strictObject({ applies: z.literal(true) }),
  z.strictObject({
    applies: z.literal(false),
    because: z.enum(['harness-has-no-login', 'credential-is-not-a-login']),
    /** The harness's own declared sentence. Present only when the harness is what declined. */
    harnessReason: NonEmptyStringSchema.optional(),
  }),
]);
export type FleetLoginApplicability = z.infer<typeof FleetLoginApplicabilitySchema>;

/**
 * What the credential store found in one home — a classification, never material.
 *
 * State-discriminated so that an absent expiry renders as absence rather than as a stale countdown,
 * and so `unreadable` cannot arrive without the reason it owes the reader. `not-read` is the fifth
 * member and it is not `missing`: nothing was looked at, because this account's credential does not
 * come from a login, and reporting `missing` would tell a correctly-configured account it is broken.
 */
export const FleetCredentialReadingSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('valid'), expiresAt: InstantSchema.optional() }),
  z.strictObject({ state: z.literal('refreshable'), expiresAt: InstantSchema.optional() }),
  z.strictObject({ state: z.literal('missing') }),
  z.strictObject({ state: z.literal('unreadable'), reason: NonEmptyStringSchema }),
  z.strictObject({ state: z.literal('not-read') }),
]);
export type FleetCredentialReading = z.infer<typeof FleetCredentialReadingSchema>;

/** One account, and everything a login surface needs to decide what to offer it. */
export const FleetLoginAccountSchema = z.strictObject({
  accountId: AccountIdSchema,
  kind: HarnessKindSchema,
  displayName: NonEmptyStringSchema,
  /**
   * The executable NAME, not the published path.
   *
   * Two reasons, and the second is load-bearing: it is the word a person recognises and types, and it is
   * the key `GET /v1/usage` reports each account under — so a surface can join this row to a quota figure
   * without deriving a basename of its own. The path is on `/v1/fleet/accounts` for anybody who needs it.
   */
  wrapper: NonEmptyStringSchema,
  mode: AccountModeSchema,
  available: z.boolean(),
  credential: FleetCredentialReadingSchema,
  source: FleetCredentialSourceSchema,
  login: FleetLoginApplicabilitySchema,
});
export type FleetLoginAccount = z.infer<typeof FleetLoginAccountSchema>;

/**
 * What one provider login needs. Accounts, not one account, because the credential is shared.
 *
 * There is no such thing as logging half an identity in: one approval covers every lane, which is why
 * thirty wrappers on six provider accounts cost six interactions rather than thirty. A surface that
 * offered a per-account button would spend an approval per lane and leave siblings signed out.
 *
 * The verdict is the fleet's own, unflattened. `login` and `indeterminate` are not the same state:
 * the first asks for an approval, the second says a home could not be read and refuses to decide —
 * and a surface that offered a login for the second would overwrite a credential that may be fine.
 */
export const FleetLoginIdentitySchema = z.strictObject({
  /** `<kind>:<identity>` for a declared identity; `account:<id>` for one the configuration lost. */
  identity: NonEmptyStringSchema,
  kind: HarnessKindSchema,
  verdict: z.enum(['complete', 'sync', 'login', 'indeterminate', 'no-login']),
  /** Why, for the verdicts that owe a reason. */
  reason: NonEmptyStringSchema.optional(),
  accounts: z.array(FleetLoginAccountSchema).min(1).readonly(),
});
export type FleetLoginIdentity = z.infer<typeof FleetLoginIdentitySchema>;

/** Which provider logins this host has, and what each one needs. */
export const FleetLoginReadinessSchema = z.strictObject({
  identities: z.array(FleetLoginIdentitySchema).readonly(),
});
export type FleetLoginReadiness = z.infer<typeof FleetLoginReadinessSchema>;

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
 * Ask one account's credential to renew itself.
 *
 * Names an ACCOUNT, exactly as a login start does, because a person clicks a row. The daemon resolves
 * which identity that account belongs to and which home to fire at; there is no shape of request that
 * could name a command, a path, a wrapper or a home.
 */
export const FleetRenewalRequestSchema = z.strictObject({
  accountId: AccountIdSchema,
  /**
   * The per-change confirmation, for a governed caller that owes one.
   *
   * The SAME gate a login start sits behind, and not a second one. A renewal is not a sign-in, but it
   * does mutate shared credential state on the host, and a rotation the provider refuses makes the
   * harness clear its own tokens — so a caller who can drive it from off this machine can leave an
   * identity needing a person. That is a change to how the host behaves, which is what
   * `fleet`/`configure` plus this confirmation already governs.
   */
  operatorPassword: OperatorPasswordSchema.optional(),
});
export type FleetRenewalRequest = z.infer<typeof FleetRenewalRequestSchema>;

/**
 * What one renewal did, and to which home.
 *
 * `ran` is NOT a success — a renewal that ran and achieved nothing has `ran` true and a status of
 * `failed`. It says the harness was given its turn, so the credential on disk may have moved in either
 * direction and any reading a caller is holding is now history. A surface that treated it as success
 * would report a spent refresh token as a working login.
 *
 * `accountId` is optional because a refusal can arrive before any home was chosen: an identity that
 * authenticates with a key has no home to name, and inventing one would point a reader at an account
 * this renewal never looked at.
 */
export const FleetRenewalSchema = z.strictObject({
  /** `<kind>:<identity>`, because a credential belongs to an identity rather than to an account. */
  identity: NonEmptyStringSchema,
  status: FleetRenewalStatusSchema,
  /** The home that was renewed, or chosen and then refused. Absent when none was chosen. */
  accountId: AccountIdSchema.optional(),
  /** Why, in the terms of the credential — never of the credential's contents. */
  reason: NonEmptyStringSchema.optional(),
  ran: z.boolean(),
});
export type FleetRenewal = z.infer<typeof FleetRenewalSchema>;

/**
 * What happened to one account when a flow finished.
 *
 * The fleet's own outcomes, carried rather than collapsed: `usable`, `login-needed` and
 * `indeterminate` are three different reasons nothing was done, and merging them is how a report ends
 * up implying a fleet is signed in when two of its identities were never checked.
 *
 * `renewed` is a SUCCESS and not a sign-in: the credential was refreshed with no browser and nobody was
 * asked. This flow cannot produce one today — it passes no renewal dependency — and the member is here
 * anyway, because this schema projects the domain's whole union rather than the subset one caller happens
 * to reach. A projection narrower than its source turns a later wiring decision into a 500.
 */
export const FleetLoginAccountOutcomeSchema = z.strictObject({
  accountId: AccountIdSchema,
  status: z.enum([
    'logged-in',
    'renewed',
    'synced',
    'usable',
    'not-required',
    'login-needed',
    'indeterminate',
    'unavailable',
    'failed',
  ]),
  message: NonEmptyStringSchema.optional(),
});
export type FleetLoginAccountOutcome = z.infer<typeof FleetLoginAccountOutcomeSchema>;

/** Every flow state carries these, in every state, so a reader never has to ask which flow it holds. */
const flowShape = {
  flowId: NonEmptyStringSchema,
  /** The account whose wrapper was launched. Its identity's other lanes receive a copy. */
  accountId: AccountIdSchema,
  identity: NonEmptyStringSchema,
  startedAt: InstantSchema,
  /** When this flow is abandoned and its child killed. Bounded in minutes, never open-ended. */
  expiresAt: InstantSchema,
};

/** Present in `failed` on both flows: what went wrong, and the host command that always works. */
const failureShape = {
  reason: NonEmptyStringSchema,
  /**
   * The way back, named at the point of failure.
   *
   * `fy fleet login` inherits a terminal and keeps working when every assumption this flow makes about
   * somebody else's CLI is false, so it is the fallback for the whole feature — and a refusal that did
   * not name it would strand the person who most needs it.
   */
  remedy: NonEmptyStringSchema,
};

/**
 * Claude's own login, as a state machine.
 *
 * `awaiting-code` is where this flow differs from Codex's: Claude has no device grant, so the person
 * opens the URL, signs in, and the provider's hosted page shows them a code to bring back. There is no
 * localhost callback anywhere in this path.
 */
export const ClaudeLoginFlowSchema = z.discriminatedUnion('state', [
  z.strictObject({ harness: z.literal('claude'), ...flowShape, state: z.literal('starting') }),
  z.strictObject({
    harness: z.literal('claude'),
    ...flowShape,
    state: z.literal('awaiting-code'),
    verificationUrl: HarnessLoginVerificationUrlSchema,
  }),
  z.strictObject({
    harness: z.literal('claude'),
    ...flowShape,
    state: z.literal('complete'),
    accounts: z.array(FleetLoginAccountOutcomeSchema).readonly(),
  }),
  z.strictObject({ harness: z.literal('claude'), ...flowShape, state: z.literal('failed'), ...failureShape }),
]);
export type ClaudeLoginFlow = z.infer<typeof ClaudeLoginFlowSchema>;

/**
 * Codex's own login, as a state machine.
 *
 * `awaiting-approval` carries BOTH values the provider prints, because a device grant needs both: the
 * URL to open and the code to type there. There is no submission — the child polls the provider and
 * exits on its own, so this flow has nothing for a person to bring back.
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
    state: z.literal('complete'),
    accounts: z.array(FleetLoginAccountOutcomeSchema).readonly(),
  }),
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

/** Start one identity's login. The caller names an ACCOUNT — never a command, never a path. */
export const HarnessLoginStartRequestSchema = z.strictObject({
  accountId: AccountIdSchema,
  /**
   * The per-change confirmation, for a governed caller that owes one.
   *
   * IT IS THE OPERATOR PASSWORD AND NOTHING ELSE, held to the same rule by the same schema the fleet's
   * proposal apply uses, and spent against this one start. It is not a second gate: `fleet.configure`
   * decides whether this caller may reach the route at all, and this proves the change.
   */
  operatorPassword: OperatorPasswordSchema.optional(),
});
export type HarnessLoginStartRequest = z.infer<typeof HarnessLoginStartRequestSchema>;

/**
 * The one value a person brings back, for the one harness that needs one.
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
export const HarnessLoginSubmitRequestSchema = z.strictObject({
  code: z.string().min(1).max(4_096),
});
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
