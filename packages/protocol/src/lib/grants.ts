/**
 * CAPABILITY GRANTS — what the operator has decided the UI may do on THIS machine.
 *
 * ## THE OWNER AT THE MACHINE IS UNGOVERNED; EVERY OTHER CALLER IS GOVERNED
 *
 * The owner — the command line holding the admin token, over loopback — is subject to none of this. Reading the admin token
 * already requires being on the host, so gating it would be friction with no safety, and it is the
 * door a confused remote configuration is repaired through.
 *
 * Every other caller is governed: a paired phone, a browser across the network, a session carried over
 * the rendezvous, and a browser on the host itself — a tunnel or proxy to 127.0.0.1 is indistinguishable
 * from one (docs/design/zero-trust.md B4). That is where a boundary is real.
 *
 * "Loopback" means how the request ARRIVED, decided from the carrier — never a peer address, a `Host`
 * header, or a URL that happens to say `127.0.0.1`. The relay terminates on the host it serves, so a
 * naive check would hand a remote phone full control of the machine.
 *
 * ## THE STEP-UP IS THE CONFIRMATION
 *
 * A governed caller exercising a dangerous demand — any `configure`, or `use` of `terminal`, `browser`
 * or `pairing` — must hold a recent passkey step-up for THIS device and THIS app session
 * (`./step-up.ts`). The refusal is `step-up-required`, and its wire code is `STEP_UP_REQUIRED_CODE`, so
 * the browser can ask for the passkey and retry once. There is no operator password: the step-up
 * replaced it, and nothing here reads, stores or asks for one.
 *
 * ## TWO AXES, NOT ONE
 *
 * The daemon already answers "who is asking" with a token class and "who may reach this route" with
 * a route's credential minimum and privileged-arrival declaration. Neither answers the question an operator actually asks: *I trust this phone to watch
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
 * This is a layer ON TOP of the token class and the route declaration, never a replacement for either, and
 * the invariant is one-directional: **a grant can only remove authority a credential already had.**
 * A device token still cannot reach an `admin-token` route because a grant said `use: true`; the
 * route checks run first and a grant is never consulted to permit anything. If a grant could widen, the
 * whole authorization model would be decided by a JSON file an operator edits, which is precisely
 * the outcome this contract exists to make unrepresentable.
 *
 * ## PERMISSIVE BY DEFAULT, RESTRICTIVE BY CHOICE
 *
 * Both axes default to ENABLED for every capability, `pairing` included. A person should be able to do
 * as much as possible from the UI; what stands between a paired device and a dangerous demand is the
 * passkey step-up, which needs no setup beyond pairing.
 *
 * `pairing` DESERVES A SENTENCE BECAUSE IT IS THE ONE THAT PRODUCES CREDENTIALS. Exercising it hands
 * another device access to the machine, which is why the protection it relies on is not its default but
 * the one-way gate: a caller who is not on the host may turn a capability OFF and may never turn one
 * back ON. An operator who decides that only the machine itself hands out credentials therefore makes
 * a decision that sticks, and no device that has been shut out can restore itself.
 *
 * ## ABSENCE IS STILL DENIAL
 *
 * A capability whose grant cannot be DETERMINED reads as denied. A malformed or unreadable grant
 * document is not "everything is allowed" — it is a daemon that refuses and says which document is
 * broken. Permissive defaults are a choice about what an operator who said nothing meant; damaged
 * state is not empty state, and unknown is never permitted.
 *
 * The contract lives in the protocol package because four consumers must agree on it: the daemon
 * that enforces it, the command line that reports it, the configuration document that records it, and
 * the browser that has to explain a refusal instead of greying a control out.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';

/**
 * The capabilities an operator is asked about, in the order they are asked.
 *
 * EIGHT, and the list is closed. Every one of them either reaches out of the daemon's own state onto
 * the host — spawning a shell, writing an account's wrapper, opening a browser the operator is
 * signed into, reading a working tree — or decides how much of the host the daemon may spend on its
 * own. Everything the daemon does *inside its own state home* (sessions, tasks, attention, pins) is
 * deliberately NOT here: a grant list that grows to cover every route becomes a second copy of the
 * route table, and a second copy is how the two stop agreeing.
 *
 * `pairing` is LAST because it was added last, and appending rather than inserting is deliberate: the
 * order is the order an operator is asked and reads, so an existing report's rows must not reshuffle
 * because a sixth question exists. What it reaches is not the daemon's own state either — a pairing
 * code is a credential for the machine, redeemable by whoever holds it.
 *
 * `secrets` is appended after it for the same reason. Its `use` axis runs a command with a stored
 * value in that child's environment — code execution on the host — and its `configure` axis sets and
 * deletes stored values. Before it existed those routes carried no demand at all, so any paired device
 * could run a command through them.
 *
 * `sharing` is appended after it for the same reason. Its `use` axis publishes this machine's skills and MCP
 * setups to people who are not its devices, and signs for the machine; its `configure` axis governs only
 * re-granting `sharing` (docs/catalogs.md, docs/grants.md).
 */
export const DAEMON_CAPABILITIES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;
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
 * How a CLIENT reads grants off the wire from a daemon on another version (`version-skew.ts`).
 *
 * A capability this build knows and the answer omits (an older daemon) reads as OFF, a narrowing, so
 * a hosted app newer than its daemon still opens the device screen and never shows access that was not
 * granted. A key this build does not know (a newer daemon) is dropped, so a capability added later
 * cannot break a client that has not heard of it. The result is the closed `CapabilityGrantsSchema`.
 */
export const ReadCapabilityGrantsSchema = z.preprocess(raw => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const given = raw as Record<string, unknown>;
  return Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [
      capability,
      capability in given ? given[capability] : { use: false, configure: false },
    ]),
  );
}, CapabilityGrantsSchema);

/**
 * What a device paired with a LIMITED code (`fy pair --limited`) is given: `fleet.use`, and nothing else.
 *
 * The opt-in narrowing (`docs/design/zero-trust.md` B5): a phone that can read the fleet and chat with
 * sessions, whose terminals, files, browser, secrets, warden, pairing and every `configure` axis stay
 * off until somebody widens THIS device. It is also what a device record written before per-device
 * grants reads as, because reading an absent field as the narrower answer is the safe direction.
 */
export const LIMITED_DEVICE_GRANTS: CapabilityGrants = Object.freeze(
  Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [capability, { use: capability === 'fleet', configure: false }]),
  ) as CapabilityGrants,
);

/**
 * WHY a capability is refused, in a vocabulary the UI can turn into a next step.
 *
 * NOT a free string. PR #284 established that a refusal naming the next step beats a bare denial,
 * and a next step can only be composed by something that knows WHICH of these it is. A greyed
 * control with no explanation is the dead end this exists to remove.
 *
 * - `granted` — allowed.
 * - `not-granted` — the operator turned this axis off. The next step is a host-side change.
 * - `device-not-granted` — the machine allows it, but THIS device has not been given it. The next step
 *   is widening this one device — at the machine, or from a device that holds it and `pairing.configure`.
 * - `step-up-required` — the demand is dangerous and this device holds no recent passkey step-up for
 *   this app session. The next step is a passkey confirmation on the same device, then the retry.
 * - `undetermined` — the grant document could not be read as a complete decision. Denied, loudly.
 *   Permissive DEFAULTS are a choice about what an operator who said nothing meant; they are not a
 *   choice about damaged state, and unknown is never permitted.
 */
export const GRANT_REFUSALS = [
  'granted',
  'not-granted',
  'device-not-granted',
  'step-up-required',
  'undetermined',
] as const;
export type GrantRefusal = (typeof GRANT_REFUSALS)[number];

export const GrantRefusalSchema = z.enum(GRANT_REFUSALS);

/** One capability as the UI is told about it. */
export const CapabilityGrantViewSchema = z.strictObject({
  capability: DaemonCapabilitySchema,
  /** May this caller exercise the capability right now? */
  use: z.boolean(),
  /** May this caller change the capability's host behaviour right now — step-up included? */
  configure: z.boolean(),
  /** What the operator's document says, before a step-up is considered. */
  granted: CapabilityGrantSchema,
  /**
   * What THIS device has been granted, when the caller is a governed paired device — absent for a
   * caller on the host (ungoverned) and for a credential that is not a device (a remote warden).
   * The effective answer is `granted` AND this, axis by axis.
   */
  deviceGranted: CapabilityGrantSchema.optional(),
  /** Why `use` reads the way it does. */
  useRefusal: GrantRefusalSchema,
  /** Why `configure` reads the way it does. */
  configureRefusal: GrantRefusalSchema,
  /**
   * May THIS caller turn this capability on?
   *
   * `false` for every remote caller, always — widening is a local act and no step-up buys it. It is
   * on the wire so a UI is TOLD rather than left to infer it from a rule it would have to encode a
   * second time, and so an off capability can render as "only from the machine" instead of a dead
   * toggle that fails when somebody presses it. It equals `hostLocal`.
   *
   * It is also the warning a remote caller needs BEFORE switching something off: this is a one-way
   * door, and the moment to say so is before it closes.
   */
  mayGrant: z.boolean(),
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
  /**
   * Whether the operator's grants GOVERN this caller at all.
   *
   * The inverse of `hostLocal` today: the owner at the machine (the admin token over loopback) is
   * ungoverned and every other caller, a browser on the host included, is governed. Both fields stay on the wire because they answer different
   * questions — "do the grants apply to me" and "am I at the machine" — and a screen should read the
   * one it means rather than a rule it would have to restate.
   *
   * SERVED RATHER THAN INFERRED, because the browser cannot work it out and the two ways it would try
   * are both wrong. A page loaded from a loopback address can be reaching this daemon through the relay,
   * whose tunnel sets `loopback: false` unconditionally, so anything derived from a URL or a hostname
   * would tell a remote phone it is standing at the machine — the exact inversion this whole layer
   * exists to prevent. Nor can it be read off the refusals: an ungoverned caller sees `granted` on every
   * axis, and so does a remote caller holding a step-up on a fully granted machine.
   *
   * It is what lets a UI say WHICH sentence is true — "you have this because you are at the machine",
   * "you have this because you confirmed with your passkey", or "you have this because it was granted" —
   * instead of picking one and being wrong for a real configuration.
   */
  governed: z.boolean(),
  /**
   * Whether this request ARRIVED on the machine the daemon runs on.
   *
   * THE LOCALITY FACT, ON ITS OWN. Widening is a local act and no step-up buys it, so this is what
   * decides whether a switch can ever travel back — and it is what a screen reads to say "you are at
   * this machine".
   *
   * It is the SAME carrier fact `PairedDevicesView.hostLocal` carries, spelled the same way, from one
   * source: `ApiRequest.loopback`. Neither view re-derives it, and no header can move it.
   */
  hostLocal: z.boolean(),
  /**
   * Whether this caller's device holds a recent passkey step-up for this app session right now.
   * Always `false` for a caller with no proven device; an ungoverned caller does not need one.
   */
  steppedUp: z.boolean(),
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
  /**
   * Each axis that moved, as `capability.axis=on|off` for the daemon-wide document, or
   * `<deviceId>/capability.axis=on|off` for one device's own grant. Empty is impossible — a patch that
   * changed nothing is not recorded.
   */
  changes: z.array(z.string().min(1).max(96)).readonly(),
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
 * WIDENING IS HOST-ONLY; A GOVERNED CALLER MAY ONLY NARROW. Turning an axis ON is the one change that
 * gives a remote browser more than it had, so only a caller on the host may make it. A governed caller
 * may turn axes OFF, and because that is a `configure` act it needs the same passkey step-up as any
 * other configure demand — one touch on the device already in hand, never a host-side change.
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

/**
 * Every capability on both axes — what a newly paired device is given by default (owner decision
 * 2026-10-14). The UNLOCK is the gate: a device does nothing at all until it unlocks the machine with a
 * passkey, and then may do anything for the unlock's validity. The daemon-wide document still applies on
 * top, and narrowing one device stays available.
 */
export const FULL_DEVICE_GRANTS: CapabilityGrants = Object.freeze(
  Object.fromEntries(
    DAEMON_CAPABILITIES.map(capability => [capability, { use: true, configure: true }]),
  ) as CapabilityGrants,
);
