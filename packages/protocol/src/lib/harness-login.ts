/**
 * The wire contract for a harness login the UI drives, for one account-model credential.
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
import { FleetCredentialIdSchema as CredentialIdSchema } from './fleet-credentials.ts';
import { OperatorPasswordSchema } from './grants.ts';


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
  credentialId: CredentialIdSchema,
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
  /**
   * Set when the flow ended BECAUSE of the code — refused, or no longer waited for — so a surface can say
   * so and offer a fresh one instead of a host command. Absent for every other failure.
   */
  lastCode: HarnessLoginLastCodeSchema.optional(),
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
    /**
     * Claude refused the last code and is waiting for another. Only `rejected` can happen here — a flow
     * still awaiting a code has not expired. Cleared by the next submission.
     */
    lastCode: HarnessLoginLastCodeSchema.extract(['rejected']).optional(),
  }),
  z.strictObject({ harness: z.literal('claude'), ...flowShape, state: z.literal('complete') }),
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

/** Start one login. The caller names a CREDENTIAL — never a command, never a path. */
export const HarnessLoginStartRequestSchema = z.strictObject({
  /**
   * The account-model credential to sign in (design §4.6, §7): every runtime on it, or none yet — an
   * empty slot is signed in before anything uses it.
   */
  credentialId: CredentialIdSchema,
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
