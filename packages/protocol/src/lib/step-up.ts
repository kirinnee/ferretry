import { z } from 'zod';
import { SignInRuleStageIdSchema, TaskPlanStageIdSchema, TwoFactorStageIdSchema } from './account-ids.ts';
import { ApiErrorResponseSchema, InstantSchema } from './common.ts';
import { CapabilityAxisSchema, DaemonCapabilitySchema } from './grants.ts';
import { PairedDeviceIdSchema } from './pairing.ts';
import { STEP_UP_DEFAULT_WINDOW_MINUTES } from './security.ts';

/**
 * THE PASSKEY STEP-UP, ON THE WIRE (`docs/design/zero-trust.md` B1–B2).
 *
 * The browser performs the WebAuthn ceremony and the DAEMON verifies it. Everything here travels inside
 * a session the device key opened, so the relay sees none of it; what this module fixes is the shape
 * both ends agree on — the options the daemon issues, what the browser sends back, and what a person
 * is told when it does not work.
 *
 * Binary values are unpadded base64url, the encoding every other record in this protocol uses.
 */

/**
 * How long one verified step-up covers the acts that ask for one, for one running copy of the app, on a
 * machine whose owner never changed it: the default of the `stepUpWindowMinutes` setting (`./security.ts`).
 */
export const STEP_UP_TTL_SECONDS = STEP_UP_DEFAULT_WINDOW_MINUTES * 60;

/** How long a challenge the daemon issued may be answered. It is spent on its first answer either way. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 120 as const;

/**
 * How long after pairing a device with no passkey yet may register its first one without a step-up.
 *
 * The moment the owner is holding the device. After it, a thief holding an unlocked app cannot add an
 * authenticator of their own: a second passkey needs a fresh assertion by one this device already holds
 * ({@link PasskeyRegistrationOptionsSchema}'s `confirm`), or the owner at the machine.
 */
export const PASSKEY_REGISTRATION_WINDOW_SECONDS = 600 as const;

/** How many passkeys one device may hold. Enough for a phone's platform key and a hardware key or two. */
export const MAX_PASSKEYS_PER_DEVICE = 8 as const;

/** COSE algorithm identifiers this daemon verifies: ES256, EdDSA (Ed25519) and RS256. */
export const PASSKEY_ALGORITHMS = [-7, -8, -257] as const;
export type PasskeyAlgorithmId = (typeof PASSKEY_ALGORITHMS)[number];

const Base64UrlSchema = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+$/u, 'not unpadded base64url');

/** A web origin as the browser reports it: scheme, host and port, nothing after. */
export const AppOriginSchema = z
  .string()
  .max(512)
  .refine(value => {
    try {
      const url = new URL(value);
      return url.origin === value;
    } catch {
      return false;
    }
  }, 'not a web origin');

/** What the browser asks for: options for THIS app origin, which becomes the relying-party id. */
export const PasskeyOptionsRequestSchema = z.strictObject({ origin: AppOriginSchema });
export type PasskeyOptionsRequest = z.infer<typeof PasskeyOptionsRequestSchema>;

/** The acts that add access or run someone else's code, each wanting a passkey proved for it ({@link STEP_UP_ACTS}). */
export const StepUpActSchema = z.enum([
  'add-device',
  'widen-device',
  'enable-agent-control',
  'loosen-config',
  'clone-secrets',
  'loosen-security',
  'catalog-install',
  'share-catalog',
  'share-link',
  'add-2fa-key',
  'allow-profile-targets',
  'approve-task-plan',
  'approve-sign-in-rule',
  'resume-cut-off',
]);
export type StepUpAct = z.infer<typeof StepUpActSchema>;

/**
 * THE ACTS ASKED OF EVERY CALLER, the machine itself included: no "governed" or loopback check may skip them, a
 * window grant, an unlock or `stepUpOnActions` never stands in for one, and each proof is bound to ONE thing
 * (`subject`: the staged 2FA seed, the staged task-plan selection, or the staged standing rule) so it cannot be spent
 * on another. The daemon's claim takes that subject as a required argument for these acts, so a route cannot ask for
 * one the short way.
 */
export const STEP_UP_ACTS_EVERY_CALLER = [
  'add-2fa-key',
  'approve-task-plan',
  'approve-sign-in-rule',
] as const satisfies readonly StepUpAct[];
export type EveryCallerStepUpAct = (typeof STEP_UP_ACTS_EVERY_CALLER)[number];
/** An act the machine itself (its admin token, on loopback) is never asked to prove. */
export type MachineSkippableStepUpAct = Exclude<StepUpAct, EveryCallerStepUpAct>;

/** Whether a caller at the machine may skip proving `act`: every act but {@link STEP_UP_ACTS_EVERY_CALLER}. */
export const stepUpSkippableAtMachine = (act: StepUpAct): act is MachineSkippableStepUpAct =>
  !(STEP_UP_ACTS_EVERY_CALLER as readonly StepUpAct[]).includes(act);

/**
 * The kind of staged thing each every-caller act is bound to: a 2FA seed's stage for `add-2fa-key`, a task-plan
 * selection's stage for `approve-task-plan`, a standing rule's stage for `approve-sign-in-rule`. A proof asked with
 * another act's stage is refused before any challenge is minted, so one ceremony can never be dressed up as another.
 */
export const STEP_UP_SUBJECTS = {
  'add-2fa-key': TwoFactorStageIdSchema,
  'approve-task-plan': TaskPlanStageIdSchema,
  'approve-sign-in-rule': SignInRuleStageIdSchema,
} as const satisfies Record<EveryCallerStepUpAct, z.ZodType<string>>;
/** The stage id an every-caller act's proof is bound to. */
export type StepUpSubjectOf<Act extends EveryCallerStepUpAct> = z.infer<(typeof STEP_UP_SUBJECTS)[Act]>;

/**
 * THE ACTS WHOSE PROOF IS KEPT (docs/design/zero-trust.md, "Stored passkey proofs"): the daemon derives the challenge
 * from what is being approved (never at random), and keeps the assertion itself so it can check it again later,
 * offline, against the passkey registry. Today only a standing sign-in rule, whose record carries the owner's
 * assertion for as long as it lasts. Every one is also asked of every caller.
 *
 * A stored proof is claimed only through {@link ClaimStoredProof}, and an ordinary fresh claim never takes one (nor the
 * reverse), so the evidence kept for a rule can't be spent as a step-up and a step-up can't be stored as a rule.
 */
export const STEP_UP_ACTS_STORED_PROOF = ['approve-sign-in-rule'] as const satisfies readonly EveryCallerStepUpAct[];
export type StoredProofStepUpAct = (typeof STEP_UP_ACTS_STORED_PROOF)[number];

/** Whether the daemon keeps `act`'s assertion and derives its challenge ({@link STEP_UP_ACTS_STORED_PROOF}). */
export const stepUpKeepsProof = (act: StepUpAct): act is StoredProofStepUpAct =>
  (STEP_UP_ACTS_STORED_PROOF as readonly StepUpAct[]).includes(act);

/**
 * Options for a step-up. `act` is the one act the person is about to confirm: the daemon stamps the
 * proof with it, and an act that asks for its own proof (a catalog install) takes only a proof stamped
 * for it. Absent, the proof is unstamped and no such act takes it.
 *
 * `subject` is the one thing a {@link STEP_UP_ACTS_EVERY_CALLER} act is for (the staged seed, `st_…`; the staged task-plan
 * selection, `tps_…`; the staged standing rule, `srs_…`): the daemon binds the challenge, and so the proof, to it, and
 * the commit takes only a proof for that act AND that subject. Sent exactly with such an act, of that act's own kind
 * ({@link STEP_UP_SUBJECTS}), and never with another.
 */
export const StepUpOptionsRequestSchema = PasskeyOptionsRequestSchema.extend({
  act: StepUpActSchema.optional(),
  subject: z.union([TwoFactorStageIdSchema, TaskPlanStageIdSchema, SignInRuleStageIdSchema]).optional(),
}).refine(
  request =>
    request.act === undefined || stepUpSkippableAtMachine(request.act)
      ? request.subject === undefined
      : STEP_UP_SUBJECTS[request.act].safeParse(request.subject).success,
  { path: ['subject'], message: "name the act's own staged subject exactly when the act is bound to one" },
);
export type StepUpOptionsRequest = z.infer<typeof StepUpOptionsRequestSchema>;

export const StepUpOptionsSchema = z.strictObject({
  challenge: Base64UrlSchema(128),
  rpId: z.string().min(1).max(253),
  allowCredentials: z
    .array(z.strictObject({ type: z.literal('public-key'), id: Base64UrlSchema(1_366) }))
    .min(1)
    .max(MAX_PASSKEYS_PER_DEVICE),
  timeout: z.number().int().positive(),
});
export type StepUpOptions = z.infer<typeof StepUpOptionsSchema>;

/**
 * A device key replacing the one that opened this session (`docs/design/zero-trust.md` B6): the NEW
 * key's SPKI, and its signature over `"ferretry-device-rotate-v2" ‖ 0x00 ‖ TH ‖ LP(deviceId) ‖ LP(deviceKey)`
 * for the transcript of the session carrying it. Bounded here; the daemon checks it is an Ed25519 key.
 */
export const DeviceKeyRotationSchema = z.strictObject({
  deviceKey: Base64UrlSchema(64),
  proof: Base64UrlSchema(128),
});
export type DeviceKeyRotation = z.infer<typeof DeviceKeyRotationSchema>;

/**
 * An assertion, as `navigator.credentials.get` produced it — and, once the device's key is due for
 * replacement, the replacement, so one ceremony both confirms the person and rotates the key.
 */
export const StepUpAssertionSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
  rotation: DeviceKeyRotationSchema.optional(),
});
export type StepUpAssertion = z.infer<typeof StepUpAssertionSchema>;

/**
 * A STORED PROOF: what the daemon keeps of a verified ceremony for a {@link STEP_UP_ACTS_STORED_PROOF} act, so the
 * assertion can be checked again offline — the device that proved it and the assertion's bytes exactly as the
 * authenticator signed them. Never a rotation (that is spent by the live ceremony) and never anything the browser
 * could present again as a step-up: the challenge inside `clientDataJSON` is derived from what was approved, and a
 * fresh claim never takes it.
 */
export const StoredStepUpProofSchema = z.strictObject({
  deviceId: PairedDeviceIdSchema,
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  authenticatorData: Base64UrlSchema(5_462),
  signature: Base64UrlSchema(1_366),
});
export type StoredStepUpProof = z.infer<typeof StoredStepUpProofSchema>;

/**
 * The route context's claim of a stored proof: the evidence of ONE verified ceremony for `act` bound to exactly
 * `subject`, once, while it is fresh — or `undefined`. It takes only a {@link StoredProofStepUpAct}, and always its
 * subject, so a route can neither claim a stored proof the short way nor store an ordinary step-up's.
 */
export type ClaimStoredProof = <Act extends StoredProofStepUpAct>(
  act: Act,
  subject: StepUpSubjectOf<Act>,
) => StoredStepUpProof | undefined;

/**
 * Options for a new passkey, and — when this device already holds one — the assertion that must come
 * first (`confirm`).
 *
 * ADDING A PASSKEY IS ITS OWN CEREMONY, never a step-up and never authorized by one (zero-trust.md B2).
 * Code in the page can build an attestation with WebCrypto, so nothing in a registration proves an
 * authenticator exists; what it cannot build is a signature by a passkey the daemon already trusts. So
 * a device that holds one must prove it again, against `confirm.challenge`: issued with THIS
 * registration's challenge, bound to it, and spent with it. The first passkey (the window after
 * pairing) and the owner's re-opened window carry no `confirm` — there is nothing yet to bind to.
 */
export const PasskeyRegistrationOptionsSchema = z.strictObject({
  challenge: Base64UrlSchema(128),
  rp: z.strictObject({ id: z.string().min(1).max(253), name: z.string().min(1).max(64) }),
  user: z.strictObject({
    id: Base64UrlSchema(128),
    name: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
  }),
  pubKeyCredParams: z
    .array(z.strictObject({ type: z.literal('public-key'), alg: z.number().int() }))
    .min(1)
    .max(8),
  timeout: z.number().int().positive(),
  excludeCredentials: z
    .array(z.strictObject({ type: z.literal('public-key'), id: Base64UrlSchema(1_366) }))
    .max(MAX_PASSKEYS_PER_DEVICE),
  confirm: StepUpOptionsSchema.optional(),
});
export type PasskeyRegistrationOptions = z.infer<typeof PasskeyRegistrationOptionsSchema>;

/**
 * A new credential, as `navigator.credentials.create` produced it, with the existing passkey's answer to
 * the options' `confirm` when they carried one.
 */
export const PasskeyRegistrationSchema = z.strictObject({
  credentialId: Base64UrlSchema(1_366),
  clientDataJSON: Base64UrlSchema(5_462),
  attestationObject: Base64UrlSchema(21_846),
  confirmation: StepUpAssertionSchema.optional(),
});
export type PasskeyRegistration = z.infer<typeof PasskeyRegistrationSchema>;

/**
 * A verified step-up: when it lapses. Never a value the browser could present — the daemon holds it.
 *
 * `keyRotated` is present exactly when the assertion carried a rotation and the daemon now holds the
 * new key: the browser promotes its pending key on it, and the old one opens nothing from then on.
 */
export const StepUpGrantedSchema = z.strictObject({ expiresAt: InstantSchema, keyRotated: z.literal(true).optional() });
export type StepUpGranted = z.infer<typeof StepUpGrantedSchema>;

/** One passkey this device holds, as the device list and the Security panel show it. Never a key. */
export const PasskeyViewSchema = z.strictObject({
  id: Base64UrlSchema(1_366),
  origin: AppOriginSchema,
  createdAt: InstantSchema,
});
export type PasskeyView = z.infer<typeof PasskeyViewSchema>;

/**
 * What this device may do about passkeys right now, so a surface offers only what will work.
 *
 * `registration` says how a new passkey may be added — `first-window` (just paired), `confirm-existing`
 * (by confirming with a passkey this device already holds), `reopened` (the owner re-opened a window for
 * this device at the machine) — or that it may not (`closed`); `stepUpUntil` is the current step-up's
 * end, when there is one. A step-up is never one of the ways: holding one adds nothing.
 */
export const PasskeysViewSchema = z.strictObject({
  passkeys: z.array(PasskeyViewSchema).max(MAX_PASSKEYS_PER_DEVICE),
  registration: z.enum(['first-window', 'confirm-existing', 'reopened', 'closed']),
  registrationClosesAt: InstantSchema.optional(),
  stepUpUntil: InstantSchema.optional(),
});
export type PasskeysView = z.infer<typeof PasskeysViewSchema>;

/**
 * Why a ceremony was refused, as one closed set a client branches on.
 *
 * Each is a different next step for the person: `registration-closed` means "ask the owner to re-open
 * a window at the machine, or pair again"; `no-passkey` means this app origin has none;
 * `origin-not-allowed` means this copy of the app is not one the machine serves; `rotation-required` means
 * this device's key is overdue for replacement and the assertion did not carry one; `not-verified` means
 * the passkey answer did not check out (a stale challenge, a different authenticator, a rewound
 * counter) — never which of those, because the detail helps an attacker and nobody else.
 * `not-at-machine` and `unknown-device` answer only the owner's re-open request.
 */
export const STEP_UP_REFUSALS = [
  'not-a-device',
  'origin-not-allowed',
  'registration-closed',
  'too-many-passkeys',
  'no-passkey',
  'not-verified',
  'rotation-required',
  'not-at-machine',
  'unknown-device',
] as const;
export type StepUpRefusal = (typeof STEP_UP_REFUSALS)[number];

/** The error code a refusal answers with, distinct per reason so a client never parses prose. */
export const stepUpRefusalCode = (refusal: StepUpRefusal): string => `step_up_${refusal.replaceAll('-', '_')}`;

/**
 * The error code a governed route answers with when it needs a step-up this caller does not hold.
 *
 * Spelled the way the grant layer spells every refusal (`grant_` + the refusal), because it IS a grant
 * refusal: the operator allowed the act, and this copy of the app has not proved its owner recently.
 */
export const STEP_UP_REQUIRED_CODE = 'grant_step_up_required' as const;

/**
 * The demand that needed the step-up: which capability, and which of its two axes.
 *
 * A closed pair and nothing else, on purpose — never a path, a session name or anything taken from the
 * request, because the person reads a sentence built from it on a prompt the DAEMON caused.
 */
export const StepUpDemandSchema = z.strictObject({
  capability: DaemonCapabilitySchema,
  axis: CapabilityAxisSchema,
  /**
   * The ONE act this confirmation is for, when the act is one that adds access to this machine and so
   * wants a passkey proved for it alone ({@link STEP_UP_ACTS}). Absent for every other step-up.
   */
  act: StepUpActSchema.optional(),
});
export type StepUpDemand = z.infer<typeof StepUpDemandSchema>;

/**
 * The acts that ADD ACCESS to a machine, and so always need a fresh passkey confirmation of their own
 * from a device — even an unlocked one, even with `stepUpOnActions` off (owner decision 2026-10-14).
 * The machine itself (its admin token, on the host) is never asked, except for {@link STEP_UP_ACTS_EVERY_CALLER}.
 */
export const STEP_UP_ACTS = {
  /** Minting a pairing code: the next device to redeem it gets access. */
  addDevice: 'add-device',
  /** Turning on, for another device, something it did not hold. */
  widenDevice: 'widen-device',
  /**
   * Turning "what agents may control" back ON (terminals/browsers/files) from a REMOTE device
   * (owner decision, T). Turning one OFF never needs this — only the ON half of a write does, so a
   * remote owner who switched one off by accident can always switch it back on again, with a
   * passkey, without going home.
   */
  enableAgentControl: 'enable-agent-control',
  /**
   * Putting into effect a configuration-file edit that LOOSENS what this machine may spend or what its
   * agents may do (docs/config-files.md): the edit is held, the tighter version stays in effect, and
   * a remote owner confirms it with a passkey proved for this act alone.
   */
  loosenConfig: 'loosen-config',
  /**
   * Sealing this machine's secrets for another machine (docs/secrets.md). The values leave this daemon,
   * encrypted to the other one, so every copy wants a passkey proved for it alone (owner decision
   * 2026-10-20: "require the passkey again").
   */
  cloneSecrets: 'clone-secrets',
  /**
   * Raising a security setting a device may loosen with a passkey ({@link SECURITY_PASSKEY_WIDEN_FIELDS}
   * in `security.ts`) — today how long one unlock lasts. The person proving presence for this one change
   * IS the owner's consent, so it is applied at once and journaled rather than sent to the machine
   * (owner decision 2026-10-21).
   */
  loosenSecurity: 'loosen-security',
  /**
   * Installing, or updating, an item from a catalog someone else published (docs/catalogs.md). A skill is
   * instructions a ferret follows and an MCP setup is a program this machine runs, so every install
   * wants a passkey proved for it alone — even inside an unlock (owner decision Q7). Removing one never asks.
   */
  catalogInstall: 'catalog-install',
  /**
   * Minting a share code for a catalog (docs/catalogs.md § Members): the next browser to redeem it can read
   * what the catalog holds, so every code wants a passkey proved for it alone, like a pairing code.
   */
  shareCatalog: 'share-catalog',
  /**
   * Publishing one item as a link anyone holding it can install; a copy cannot be recalled. Making a link, moving a
   * public one to another version and lengthening or uncapping it each want a passkey proved for this act alone: a
   * `share-catalog` proof never buys a link and the reverse. Copying a link needs only the unlock; turning one off
   * never asks (catalogs 3f; the act is confirmed).
   */
  shareLink: 'share-link',
  /**
   * Saving a 2FA seed, so Ferretry makes that account's codes (docs/input-requests.md, "Accounts and sign-ins"). Then the
   * password and the code come from one machine, and the admin token every ferret holds could otherwise add a seed to
   * any account. So this is the one act asked of EVERY caller, the machine itself included, and its proof is bound to
   * the one staged seed it saves ({@link STEP_UP_ACTS_EVERY_CALLER}). Removing a key never asks.
   */
  addTwoFactorKey: 'add-2fa-key',
  /**
   * Letting secure-copy rules paste into programs from the owner's OWN profile (`~/.nix-profile`), which any process
   * running as the owner — every ferret — can change (docs/secure-copy.md, owner decision !A182). Turning it OFF
   * never asks.
   */
  allowProfileTargets: 'allow-profile-targets',
  /**
   * Approving the SIGN-IN lines of a ferret's task plan (task-plan.ts, docs/secure-copy.md): Ferretry then types an
   * account's password, and maybe its code, with no tap. The admin token every ferret holds could otherwise approve a
   * ferret's own plan, so this is asked of EVERY caller, the machine itself included, and its proof is bound to the one
   * staged selection it commits (`taskPlanApprovalSubject`). A selection of paste lines only never asks; revoking never
   * asks.
   */
  approveTaskPlan: 'approve-task-plan',
  /**
   * Creating, widening, resuming or renewing a STANDING SIGN-IN RULE (sign-in-rules.ts): Ferretry then fills one
   * sign-in for any ferret, with no tap, for up to 90 days. Asked of EVERY caller, the machine included, bound to the
   * one staged rule body (`signInRuleSubject`), and the assertion is KEPT with the rule
   * ({@link STEP_UP_ACTS_STORED_PROOF}) so the daemon checks it again before every fill. Narrowing and revoking never ask.
   */
  approveSignInRule: 'approve-sign-in-rule',
  /**
   * Bringing back a ferret the owner CUT OFF (`fy session revoke-credential`) from a paired device: the resume rotates in
   * a new credential, so it is a widen, and wants `fleet.configure` on the device and a passkey proved for it alone.
   * A session nobody cut off resumes without it; the CLI and the app on the host never ask.
   */
  resumeCutOff: 'resume-cut-off',
} as const satisfies Record<string, NonNullable<StepUpDemand['act']>>;

/**
 * The `403 grant_step_up_required` body: the ordinary error envelope plus the {@link StepUpDemand}.
 *
 * The daemon builds it and the app parses it, so a person tapping "Use passkey" is told WHICH act they
 * are confirming. It names the act; it does not prove it — code in the page can still ask.
 */
export const StepUpRequiredBodySchema = ApiErrorResponseSchema.extend({
  code: z.literal(STEP_UP_REQUIRED_CODE),
  demand: StepUpDemandSchema,
});
export type StepUpRequiredBody = z.infer<typeof StepUpRequiredBodySchema>;

/**
 * The OWNER, at the machine, re-opens the passkey registration window for one paired device.
 *
 * The recovery path, and the only one: a browser is never "at the machine" (B4), so a device that missed
 * its first window and holds no passkey — or lost the authenticator that held it — could otherwise never
 * step up again. The window is {@link PASSKEY_REGISTRATION_WINDOW_SECONDS} long, opens for exactly one
 * device, and is spent by the first passkey registered in it.
 */
export const PASSKEY_WINDOW_PATH = '/v1/passkeys/registration-window' as const;

export const PasskeyWindowRequestSchema = z.strictObject({ deviceId: PairedDeviceIdSchema });
export type PasskeyWindowRequest = z.infer<typeof PasskeyWindowRequestSchema>;

export const PasskeyWindowOpenedSchema = z.strictObject({
  deviceId: PairedDeviceIdSchema,
  deviceName: z.string().min(1).max(200),
  closesAt: InstantSchema,
});
export type PasskeyWindowOpened = z.infer<typeof PasskeyWindowOpenedSchema>;
