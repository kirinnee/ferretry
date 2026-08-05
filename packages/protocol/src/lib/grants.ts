/**
 * CAPABILITY GRANTS — what the operator has decided the UI may do on THIS machine.
 *
 * ## LOOPBACK IS UNGOVERNED; THIS IS ABOUT THE CALLER WHO IS NOT ON THE HOST
 *
 * Somebody on the machine already HAS the machine — they can edit the configuration, run the command
 * line, or start anything. Gating them would be friction with no safety, so a loopback caller is
 * subject to none of this and the common case needs no setup at all. Everything below applies to a
 * caller who reached this daemon from somewhere else: a paired phone, a browser across the network, a
 * session carried over the rendezvous.
 *
 * "Loopback" means how the request ARRIVED, decided from the carrier — never a peer address, a `Host`
 * header, or a URL that happens to say `127.0.0.1`. The relay terminates on the host it serves, so a
 * naive check would hand a remote phone full control of the machine.
 *
 * ## TWO AXES, NOT ONE
 *
 * The daemon already answers "who is asking" with a token class and "who may reach this route" with
 * a route scope. Neither answers the question an operator actually asks: *I trust this phone to watch
 * my agents, but I do not trust it to reconfigure the supervisor that decides whether they may spend
 * a session.* That is a per-capability decision, and it has TWO axes rather than one.
 *
 * - **use** — may the UI exercise this capability at all?
 * - **configure** — may the UI change how this capability behaves on the host?
 *
 * They are genuinely different questions, and the common answer is "use yes, configure no": watching
 * the warden is ordinary operation, and raising its concurrency cap decides how much of somebody's
 * quota the machine may spend without being asked.
 *
 * ## A GRANT ONLY EVER NARROWS
 *
 * This is a layer ON TOP of the token class and the route scope, never a replacement for either, and
 * the invariant is one-directional: **a grant can only remove authority a credential already had.**
 * A device token still cannot reach an `admin` route because a grant said `use: true`; the scope
 * check runs first and a grant is never consulted to permit anything. If a grant could widen, the
 * whole authorization model would be decided by a JSON file an operator edits, which is precisely
 * the outcome this contract exists to make unrepresentable.
 *
 * ## PERMISSIVE BY DEFAULT, RESTRICTIVE BY CHOICE
 *
 * Both axes default to ENABLED for every capability. A person should be able to do as much as
 * possible from the UI, and the security model is a layer a cautious operator turns on rather than a
 * wall everyone starts behind. The layer is the OPERATOR PASSWORD: set one, and every `configure`
 * demand needs an unlock; set none, and nothing is obstructed.
 *
 * That direction has an honest cost, and it is named rather than hidden: with permissive defaults and
 * no password, anyone holding a pairing can change this machine's fleet and settings. It is stated in
 * one plain sentence wherever remote access is arranged or inspected — once, never as nagging, and
 * never as a question somebody has to answer to use their own machine over loopback.
 *
 * ## ABSENCE IS STILL DENIAL
 *
 * A capability whose grant cannot be DETERMINED reads as denied. A malformed or unreadable grant
 * document is not "everything is allowed" — it is a daemon that refuses and says which document is
 * broken. Permissive defaults are a choice about what an operator who said nothing meant; damaged
 * state is not empty state, and unknown is never permitted.
 *
 * The contract lives in the protocol package because four consumers must agree on it: the daemon
 * that enforces it, the command line that asks the operator for it, the configuration document that
 * records it, and the browser that has to explain a refusal instead of greying a control out.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * The capabilities an operator is asked about, in the order they are asked.
 *
 * FIVE, and the list is closed. Every one of them either reaches out of the daemon's own state onto
 * the host — spawning a shell, writing an account's wrapper, opening a browser the operator is
 * signed into, reading a working tree — or decides how much of the host the daemon may spend on its
 * own. Everything the daemon does *inside its own state home* (sessions, tasks, attention, pins) is
 * deliberately NOT here: a grant list that grows to cover every route becomes a second copy of the
 * route table, and a second copy is how the two stop agreeing.
 */
export const DAEMON_CAPABILITIES = ['fleet', 'terminal', 'browser', 'filesystem', 'warden'] as const;
export type DaemonCapability = (typeof DAEMON_CAPABILITIES)[number];

export const DaemonCapabilitySchema = z.enum(DAEMON_CAPABILITIES);

/** The two questions asked about each capability. */
export const CAPABILITY_AXES = ['use', 'configure'] as const;
export type CapabilityAxis = (typeof CAPABILITY_AXES)[number];

export const CapabilityAxisSchema = z.enum(CAPABILITY_AXES);

/**
 * One capability's answer to both questions.
 *
 * BOTH FIELDS ARE REQUIRED. An optional axis would have to default, and a default that is not
 * written down is a value nobody chose being enforced as though somebody had. The DOCUMENT may omit
 * a capability entirely — see `CapabilityGrantsDocumentSchema` — and what an omission means is
 * decided in exactly one place rather than field by field.
 */
export const CapabilityGrantSchema = z.strictObject({
  use: z.boolean(),
  configure: z.boolean(),
});
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

/**
 * The complete decision: every capability, both axes, nothing missing.
 *
 * A `strictObject` with every key required, because this is the shape the daemon ENFORCES from. A
 * partial one reaching the enforcement path is the "cannot be determined" case, and that case must
 * be impossible to represent here rather than handled defensively at each call site.
 */
export const CapabilityGrantsSchema = z.strictObject(
  Object.fromEntries(DAEMON_CAPABILITIES.map(capability => [capability, CapabilityGrantSchema])) as {
    readonly [K in DaemonCapability]: typeof CapabilityGrantSchema;
  },
);
export type CapabilityGrants = z.infer<typeof CapabilityGrantsSchema>;

/**
 * How long one successful unlock stays usable, how many wrong passwords a daemon tolerates, and how
 * long it then refuses to listen.
 *
 * POLICY, not a daemon detail, for the reason the fleet approval's numbers are: the command line
 * prints them to the person typing, and the browser tells them how many tries are left. Three copies
 * of a number that must agree is three chances for it to stop agreeing.
 *
 * The window is SHORT. An unlock is held while a person changes a setting, not for a session: a
 * token that outlived the browser tab it was minted in is a standing configure grant nobody
 * re-consented to.
 */
export const GRANT_UNLOCK_TTL_SECONDS = 300 as const;
export const GRANT_UNLOCK_MAX_ATTEMPTS = 5 as const;
export const GRANT_UNLOCK_LOCKOUT_SECONDS = 900 as const;

/**
 * The header a configure-axis request carries its unlock on.
 *
 * A HEADER, never a query parameter: a URL reaches every proxy's access log, and an unlock in a log
 * outlives its five minutes. This is the same reason the fleet approval code travels in a body.
 */
export const OPERATOR_UNLOCK_HEADER = 'x-ferretry-operator-unlock';

/** An opaque unlock, minted by the daemon. Never derived from the password. */
export const OperatorUnlockTokenSchema = z.string().regex(/^fy_unlock_[A-Za-z0-9_-]{22,}$/u, 'invalid unlock token');
export type OperatorUnlockToken = z.infer<typeof OperatorUnlockTokenSchema>;

/**
 * The shortest password the daemon will accept.
 *
 * Modest on purpose. This gates a LOCAL privileged change behind a rate limiter, not an internet
 * login: the realistic attacker is somebody holding a paired device, and five attempts per fifteen
 * minutes does more work than length ever will. Refusing a person's choice with a character-class
 * lecture buys nothing here and reliably produces a password on a sticky note.
 */
export const OPERATOR_PASSWORD_MIN_LENGTH = 8 as const;

export const OperatorPasswordSchema = z
  .string()
  .min(OPERATOR_PASSWORD_MIN_LENGTH, `an operator password must be at least ${OPERATOR_PASSWORD_MIN_LENGTH} characters`)
  .max(1024)
  .refine(value => value.trim() !== '', 'an operator password must not be only whitespace');

/**
 * WHY a capability is refused, in a vocabulary the UI can turn into a next step.
 *
 * NOT a free string. PR #284 established that a refusal naming the next step beats a bare denial,
 * and a next step can only be composed by something that knows WHICH of these it is. A greyed
 * control with no explanation is the dead end this exists to remove.
 *
 * - `granted` — allowed, and the operator password stood behind it.
 * - `ungated` — allowed, and NOTHING stood behind it, because this machine has no operator password.
 *   It is a disclosure, not a refusal: the product is permissive by default and the password is the
 *   layer a cautious operator adds, so a UI showing this should say plainly that any paired browser
 *   can do this — once, where the control is, not as a recurring warning.
 * - `not-granted` — the operator turned this axis off. The next step is a host-side change.
 * - `locked` — an operator password exists and the caller has not presented a valid unlock.
 * - `rate-limited` — too many wrong passwords; the daemon is refusing to listen for a while.
 * - `undetermined` — the grant document could not be read as a complete decision. Denied, loudly.
 *   Permissive DEFAULTS are a choice about what an operator who said nothing meant; they are not a
 *   choice about damaged state, and unknown is never permitted.
 */
export const GRANT_REFUSALS = ['granted', 'ungated', 'not-granted', 'locked', 'rate-limited', 'undetermined'] as const;
export type GrantRefusal = (typeof GRANT_REFUSALS)[number];

export const GrantRefusalSchema = z.enum(GRANT_REFUSALS);

/** One capability as the UI is told about it. */
export const CapabilityGrantViewSchema = z.strictObject({
  capability: DaemonCapabilitySchema,
  /** May this caller exercise the capability right now? */
  use: z.boolean(),
  /** May this caller change the capability's host behaviour right now — unlock included? */
  configure: z.boolean(),
  /** What the operator's document says, before an unlock or a password is considered. */
  granted: CapabilityGrantSchema,
  /** Why `use` reads the way it does. */
  useRefusal: GrantRefusalSchema,
  /** Why `configure` reads the way it does. */
  configureRefusal: GrantRefusalSchema,
  /**
   * Whether the operator wrote this capability down, or the product answered for them.
   *
   * THE SAME PROVENANCE TREATMENT `--print-config` GIVES EVERY OTHER VALUE, and for the same reason:
   * a person reading a permission report is usually asking why something is refused, and "which of
   * these did I choose and which did something choose for me" is the question. An operator may write
   * a value identical to the default, so this cannot be derived by comparison — it is what the
   * document actually holds.
   */
  origin: z.enum(['default', 'config file']),
});
export type CapabilityGrantView = z.infer<typeof CapabilityGrantViewSchema>;

/**
 * The whole picture, as one read.
 *
 * ONE call rather than a probe per control, because a UI that discovers its limits by watching calls
 * fail cannot explain anything before the person clicks — and explaining before the click is the
 * entire requirement.
 */
export const GrantsViewSchema = z.strictObject({
  capabilities: z.array(CapabilityGrantViewSchema).readonly(),
  /** Whether an operator password exists at all. NEVER the password, its hash, or its length. */
  passwordSet: z.boolean(),
  /** Whether the caller currently holds a valid unlock. */
  unlocked: z.boolean(),
  /** When the held unlock expires, when one is held. */
  unlockExpiresAt: InstantSchema.optional(),
  /** Attempts left before the daemon stops listening. Absent when no password is set. */
  attemptsRemaining: z.number().int().nonnegative().optional(),
  /** When a rate-limited daemon will accept a password again. */
  lockedUntil: InstantSchema.optional(),
});
export type GrantsView = z.infer<typeof GrantsViewSchema>;

/**
 * How many recorded changes one read returns, newest first.
 *
 * BOUNDED, because the journal is append-only and a machine that has been reconfigured for a year
 * would otherwise be asked to materialise its whole history to answer "what changed recently". The
 * question people actually have is the last few, and a person who needs more can read the file.
 */
export const GRANT_AUDIT_MAX_ENTRIES = 50 as const;

/** One recorded grant change, as a reader is told about it. */
export const GrantAuditEntryViewSchema = z.strictObject({
  at: InstantSchema,
  /**
   * WHO, as the resolved actor — `admin-cli`, `admin-ui`, `device:<id>`. Never a token: a durable
   * record of who did something must not become a durable record of the credential they did it with.
   */
  actor: z.string().min(1).max(256),
  /** Each axis that moved, as `capability.axis=on|off`. Empty is impossible — a patch that changed
   *  nothing is not recorded. */
  changes: z.array(z.string().min(1).max(64)).readonly(),
});
export type GrantAuditEntryView = z.infer<typeof GrantAuditEntryViewSchema>;

/**
 * The recent history of who changed what.
 *
 * `unreadable` IS NOT DECORATION. A journal line this daemon cannot parse is damage, and silently
 * dropping it would let a tampered or truncated history read as a clean one — the exact
 * absent-evidence-as-benign-result defect the rest of this contract is built to refuse. The count
 * travels with the entries so a reader is told their history is incomplete rather than shown a
 * shorter one.
 */
export const GrantAuditViewSchema = z.strictObject({
  entries: z.array(GrantAuditEntryViewSchema).readonly(),
  /** Lines in the window that could not be read as a record. Non-zero means the history is damaged. */
  unreadable: z.number().int().nonnegative(),
  /** Whether older records exist outside the window this read covered. */
  truncated: z.boolean(),
});
export type GrantAuditView = z.infer<typeof GrantAuditViewSchema>;

/**
 * Setting or clearing the operator password from the host.
 *
 * AN ABSENT `password` CLEARS IT. That is a real operation — an operator may decide their machine no
 * longer needs the layer — and it is spelled as absence rather than as an empty string so a client
 * bug producing `""` fails the minimum-length rule instead of silently disarming the gate.
 */
export const GrantPasswordRequestSchema = z.strictObject({ password: OperatorPasswordSchema.optional() });
export type GrantPasswordRequest = z.infer<typeof GrantPasswordRequestSchema>;

/** The unlock exchange. The password travels in a body, never in a path or a query. */
export const GrantUnlockRequestSchema = z.strictObject({ password: z.string().min(1).max(1024) });
export type GrantUnlockRequest = z.infer<typeof GrantUnlockRequestSchema>;

export const GrantUnlockViewSchema = z.strictObject({
  token: OperatorUnlockTokenSchema,
  expiresAt: InstantSchema,
  ttlSeconds: z.number().int().positive(),
});
export type GrantUnlockView = z.infer<typeof GrantUnlockViewSchema>;

/**
 * A change to the grants themselves.
 *
 * PARTIAL, so a UI may change one answer without restating four it did not look at — restating them
 * is how a stale tab silently reverts a decision made in another one.
 *
 * Changing capability X's grant is itself a `configure` act ON X, so a governed caller must hold the
 * `configure` axis for every capability the patch names. That is what keeps the configure axis
 * meaningful for capabilities whose own settings do not yet have a route: an operator who says the UI
 * may not configure `terminal` is also saying the UI may not re-grant itself `terminal`.
 *
 * WIDENING NEEDS THE PASSWORD; NARROWING NEVER DOES. Turning an axis ON is the one change that gives
 * a remote browser more than it had, so it needs an unlock whenever a password exists. Turning one
 * OFF is the change somebody makes during an incident, and a password prompt between a person and
 * shutting a door is a liability — revoking must never be harder than granting.
 */
export const GrantsPatchSchema = z
  .strictObject(
    Object.fromEntries(
      DAEMON_CAPABILITIES.map(capability => [
        capability,
        z.strictObject({ use: z.boolean().optional(), configure: z.boolean().optional() }).optional(),
      ]),
    ) as {
      readonly [K in DaemonCapability]: z.ZodOptional<
        z.ZodObject<{ use: z.ZodOptional<z.ZodBoolean>; configure: z.ZodOptional<z.ZodBoolean> }>
      >;
    },
  )
  .refine(patch => Object.values(patch).some(value => value !== undefined), 'a grant patch must change something');
export type GrantsPatch = z.infer<typeof GrantsPatchSchema>;
