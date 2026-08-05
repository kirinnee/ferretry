/**
 * WHAT THE BROWSER SAYS WHEN THE OPERATOR HAS SAID NO.
 *
 * The daemon already decides everything; this module decides nothing. Its whole job is to turn the
 * two things the daemon hands over — a `GrantRefusal` on the grant view, and a `grant_*` code on a
 * 403 from an ordinary route — into a sentence naming the NEXT STEP, plus the one bit of state a
 * control needs: whether an unlock would help.
 *
 * ## WHY THE COPY IS HERE AND NOT AT EACH CONTROL
 *
 * A greyed control with no explanation is the dead end this feature exists to remove, and the way
 * that dead end comes back is one surface at a time: the Fleet tab words a refusal, then the Files
 * pane words it differently, then the terminal deck shows the raw message. `docs/grants.md` is the
 * contract and this is its single browser-side rendering, so a refusal reads the same wherever it
 * lands and a new refusal reason cannot be added without a sentence being written for it.
 *
 * ## THE UNLOCK IS A VALUE, NOT A STORE
 *
 * There is deliberately no class here, no module-scope cache and no storage of any kind. An unlock is
 * held for its TTL by the ONE screen that earned it and dies with that screen — the protocol's own
 * words are that "a token that outlived the browser tab it was minted in is a standing configure
 * grant nobody re-consented to", and a document-lifetime store in the app's registry would be
 * exactly that. What lives here instead is the pure part: a held unlock is STAMPED with the daemon
 * that minted it, and `usableUnlock` refuses it for any other daemon and after its expiry, so one
 * machine's unlock can never be presented to another even inside a single screen.
 *
 * ## NARROWING IS NEVER GATED
 *
 * `grantChangeNeedsUnlock` exists so an unlock prompt appears only where it is genuinely needed.
 * Turning an axis OFF is what somebody does during an incident and is gated by nothing but the
 * `configure` grant; turning one ON is the change that hands a remote browser more than it had. A UI
 * that prompted for a password before a revoke would be a liability, so the asymmetry is computed
 * once, here, from the view the daemon served.
 */

import {
  type CapabilityAxis,
  type CapabilityGrantView,
  type DaemonCapability,
  GRANT_UNLOCK_MAX_ATTEMPTS,
  type GrantRefusal,
  type GrantsPatch,
  type GrantsView,
} from '@ferretry/protocol';
import type { DaemonId } from './daemon-connection.ts';

/**
 * The capability as an operator reads it, so a refusal names a thing rather than a key.
 *
 * A SECOND COPY OF THE DAEMON'S NOUNS, and that is not an accident: `packages/daemon` is a server
 * package this browser bundle must never import, and the protocol carries the wire contract rather
 * than prose. The nouns are pinned by a test against `DAEMON_CAPABILITIES` so the list cannot fall
 * behind the enum, which is the only drift that would matter.
 */
const CAPABILITY_NOUNS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'the agent fleet',
  terminal: 'session terminals',
  browser: 'the browser',
  filesystem: 'session working trees',
  warden: 'fleet supervision',
  pairing: 'device pairing',
};

export const capabilityNoun = (capability: DaemonCapability): string => CAPABILITY_NOUNS[capability];

/** The heading a capability's row carries. Title case, because it labels a group of controls. */
const CAPABILITY_LABELS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'Agent fleet',
  terminal: 'Session terminals',
  browser: 'Browser',
  filesystem: 'Session files',
  warden: 'Fleet supervision',
  pairing: 'Device pairing',
};

export const capabilityLabel = (capability: DaemonCapability): string => CAPABILITY_LABELS[capability];

/**
 * What each capability actually reaches, in one line.
 *
 * Every one of them either leaves the daemon's own state and touches the HOST — spawning a shell,
 * writing an account's wrapper, driving a browser somebody is signed into, reading a working tree —
 * or decides how much of the host the daemon may spend unattended. Saying which is what makes an
 * operator's choice an informed one rather than five switches with abstract names.
 */
const CAPABILITY_REACH: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'Account manifests, wrappers written into accounts, plans, usage and apply.',
  terminal: 'Opening a shell on this machine, typing into it, and streaming what it prints.',
  browser: 'The login window and per-session control of a browser you are signed into.',
  filesystem: 'Reading the files in a session’s working tree.',
  warden: 'Supervision status, sweeps, and how much quota the daemon may spend unattended.',
  pairing:
    'Minting pairing codes that let another device reach this machine. A device that can mint credentials for more devices turns one stolen phone into standing access, so switching this off is the one decision a remote browser can never undo.',
};

export const capabilityReach = (capability: DaemonCapability): string => CAPABILITY_REACH[capability];

/** The two questions, as a person reads them rather than as the wire spells them. */
const AXIS_LABELS: Readonly<Record<CapabilityAxis, string>> = { use: 'Use', configure: 'Configure' };
const AXIS_QUESTIONS: Readonly<Record<CapabilityAxis, string>> = {
  use: 'May this browser use it at all?',
  configure: 'May this browser change how it behaves on the host?',
};

export const axisLabel = (axis: CapabilityAxis): string => AXIS_LABELS[axis];
export const axisQuestion = (axis: CapabilityAxis): string => AXIS_QUESTIONS[axis];

/**
 * What a person is told, once, when this machine has no operator password.
 *
 * ONE SENTENCE, BESIDE THE CONFIGURE CONTROLS. Not a modal, not a banner on every screen, and never
 * a question somebody has to answer to use their own machine — a loopback caller is governed by none
 * of this. It is a disclosure and it is owed exactly once: nagging teaches people to dismiss what
 * the product says, which costs more than the warning is worth.
 */
export const NO_PASSWORD_DISCLOSURE =
  'No operator password is set, so any paired device can change the settings of whatever is already turned on here — it still cannot turn anything on, which only this machine can do.';

/** The counterpart, so a machine WITH the layer on says so rather than staying silent about it. */
export const PASSWORD_SET_DISCLOSURE =
  'An operator password is set, so a paired device needs it to change the settings of whatever is already turned on here. Turning something on is only ever done at the machine.';

/**
 * THE ONE-WAY DOOR, stated wherever a remote browser can see a switch.
 *
 * ## LOCALITY GATES WIDENING NOW, NOT THE PASSWORD
 *
 * This supersedes the #289 design, and the difference is not cosmetic: a remote caller can never turn a
 * capability ON — **not even holding the operator password**. The password still gates changing the
 * settings of something already on. Any copy claiming the password lets a remote device widen a grant
 * is now false, and false in the dangerous direction, because it invites somebody to believe a
 * credential buys authority it does not buy.
 *
 * Turning something OFF from a remote browser is therefore a door that closes behind you: the only way
 * back is at the machine. That is worth saying BEFORE the click rather than in a document afterwards.
 */
export const REMOTE_ONE_WAY_NOTE =
  'A device that is not on this machine can switch these off but never back on. Turning one on is done at the machine itself.';

export const LOCAL_TWO_WAY_NOTE =
  'This browser is on the machine, so it can switch these both ways. A paired device elsewhere could only switch them off.';

/** The sentence a remote reader is shown before they close a door only the machine can reopen. */
export function remoteRevokeWarning(capability: DaemonCapability, clientName = 'fy'): string {
  return `Switching off ${capabilityNoun(capability)} from this device cannot be undone from here — turning it back on has to be done at the machine, with \`${clientName} daemon config set ${capability} --use\`.`;
}

/** What an off capability says to a caller that may not turn it on: a statement with a remedy. */
export function grantOnlyAtMachine(capability: DaemonCapability, clientName = 'fy'): string {
  return `${capabilityLabel(capability)} is switched off, and can only be switched on at the machine — an operator password does not let a paired device turn it on. Run \`${clientName} daemon config set ${capability} --use\` there.`;
}

// ─── how this browser reached this daemon ───────────────────────────────────────────────────────

/**
 * WHY a capability is open, which is a different question from WHETHER it is.
 *
 * ## THIS MUST COME FROM THE DAEMON, AND THAT IS THE WHOLE CORRECTNESS RULE
 *
 * A browser sitting on `http://127.0.0.1` can be reaching the daemon **through the relay**, and a
 * relayed hop is never loopback — `tunnelApiRequest` sets `loopback: false` unconditionally, whatever
 * address the request appears to carry. So a mark derived from `location.hostname`, the daemon's
 * `baseUrl`, or anything else the page can see would tell a remote user they were local: the exact
 * inversion the grant layer exists to prevent, re-introduced in the UI where nobody would look for it.
 * Nothing in this module reads the page's address, and nothing may.
 *
 * ## `unknown` IS A REAL STATE, NOT A MISSING ONE
 *
 * The daemon does not report this yet (`GrantsView` carries no `governed` field), and the friendly
 * assumption — "no answer means loopback" — is precisely the wrong one: it would paint a remote phone
 * as standing at the machine. So absence is its own posture and the screen says it cannot tell, in
 * keeping with the rest of this feature, where damaged state is never read as empty state.
 *
 * It also cannot be INFERRED from the refusals already on the view. A loopback caller reads `granted`
 * on every axis — and so does a remote caller holding a valid unlock on a fully-granted machine. The
 * two are indistinguishable in the current wire shape, so any inference here would be a guess that is
 * wrong for a real configuration.
 */
export type ConnectionPosture = 'direct-local' | 'governed-remote' | 'unknown';

/**
 * The posture, from the daemon's own account of the request.
 *
 * `governed` is the value `isGovernedCaller(request.loopback)` produces inside the daemon — false for a
 * caller standing on the host. `undefined` means the daemon did not say, which is its own posture.
 */
export function connectionPosture(governed: boolean | undefined): ConnectionPosture {
  if (governed === undefined) return 'unknown';
  return governed ? 'governed-remote' : 'direct-local';
}

/**
 * The posture as the CAPABILITY VIEW reveals it, which is where it actually arrives today.
 *
 * `GrantsView` carries no `governed` flag, but every capability carries `mayGrant`, and the daemon
 * computes that as exactly `!governed` (`grants/service.ts`). So the fact is already on the wire, once
 * per capability, and asking for a second field spelling the same thing would give the two a chance to
 * disagree. This reads it back rather than requesting a duplicate.
 *
 * IT REQUIRES UNANIMITY. Every capability on one connection must agree, because they are all derived
 * from one request's carrier; a view where some say yes and some say no is not a posture this can name,
 * and it fails to `unknown` rather than picking a side. An empty list is `unknown` for the same reason —
 * there is no evidence, and absence is never read as loopback.
 */
export function postureFromCapabilities(capabilities: readonly CapabilityGrantView[]): ConnectionPosture {
  if (capabilities.length === 0) return 'unknown';
  const first = capabilities[0]?.mayGrant;
  if (first === undefined || capabilities.some(entry => entry.mayGrant !== first)) return 'unknown';
  return connectionPosture(!first);
}

/** What each posture means for the whole screen, in the words a person would use about themselves. */
export interface PostureCopy {
  readonly badge: string;
  readonly headline: string;
  readonly detail: string;
  readonly tone: 'ok' | 'disclosure' | 'limit' | 'fault';
}

const POSTURE_COPY = {
  'direct-local': {
    badge: 'Direct — on this machine',
    headline: 'This browser is talking straight to the machine, so none of these limits apply to it.',
    detail:
      'Everything below is open because you are standing at the machine, not because it was granted. Somebody at the machine already has the machine, so gating them would be friction with no safety. The same browser on your phone, over the network or the relay, would be governed by every limit on this page.',
    tone: 'ok',
  },
  'governed-remote': {
    badge: 'Remote — governed',
    headline: 'This browser reached the machine from somewhere else, so the operator’s limits apply to it.',
    detail:
      'Every capability below is open only because the operator allowed it, and can be closed on the host. This is the case the limits exist for: possession of the machine is exactly what this connection does not have.',
    tone: 'disclosure',
  },
  unknown: {
    badge: 'Cannot tell',
    headline: 'This daemon did not say how it saw this connection, so Ferretry will not claim either way.',
    detail:
      'A page on 127.0.0.1 can still be reaching the machine through the relay, so the address in the address bar does not answer this and is deliberately not used. Until the daemon reports it, treat the limits below as the ones that would apply to a remote device — the safe reading, not the flattering one.',
    tone: 'fault',
  },
} satisfies Record<ConnectionPosture, PostureCopy>;

export const postureCopy = (posture: ConnectionPosture): PostureCopy => POSTURE_COPY[posture];

/**
 * Why THIS capability is open right now — the per-row version of the posture.
 *
 * `ungoverned` is the answer for every row on a loopback connection and is the distinction the owner
 * asked for: open because of where you are, rather than open because somebody decided. The other three
 * are the governed answers, and they are the reasons the daemon already gives.
 */
export type OpenReason = 'ungoverned' | 'granted' | 'ungated' | 'closed' | 'unknown';

export function openReason(entry: CapabilityGrantView, axis: CapabilityAxis, posture: ConnectionPosture): OpenReason {
  if (!axisAllowed(entry, axis)) return 'closed';
  if (posture === 'direct-local') return 'ungoverned';
  if (posture === 'unknown') return 'unknown';
  return axisRefusal(entry, axis) === 'ungated' ? 'ungated' : 'granted';
}

/** The short mark a row carries, so five rows do not all read "allowed". */
const OPEN_REASON_LABELS = {
  ungoverned: 'Open — you are at the machine',
  granted: 'Open — granted',
  ungated: 'Open — nothing behind it',
  closed: 'Closed',
  unknown: 'Open — reason unknown',
} satisfies Record<OpenReason, string>;

export const openReasonLabel = (reason: OpenReason): string => OPEN_REASON_LABELS[reason];

// ─── how much a capability hands over ──────────────────────────────────────────────────────────

/**
 * HOW MUCH ACCESS THIS CAPABILITY IS, so the dangerous ones do not look like the mild ones.
 *
 * Five rows that read alike make a person weigh `filesystem` and `fleet` the same, and they are not the
 * same: one reads files in a working tree, the other writes executables into accounts. The weight is a
 * property of what the capability REACHES — the reasoning already written down in `CAPABILITY_REACH` —
 * so it is declared per capability rather than derived from whether it happens to be on.
 *
 * ENCODED IN FORM AS WELL AS COLOUR. Three filled pips out of three is legible to somebody who cannot
 * distinguish the tones, on a monochrome print, and in a screenshot pasted into an issue. Colour alone
 * would make this an accessibility failure in the one place the product is telling somebody how much of
 * their machine they are handing over.
 */
export type AccessWeight = 'broad' | 'moderate' | 'narrow';

const CAPABILITY_WEIGHTS: Readonly<Record<DaemonCapability, AccessWeight>> = {
  // Writes executables into accounts and materialises wrappers: the widest thing here.
  fleet: 'broad',
  // Spawns a shell on the host. Anything the account can do, this can do.
  terminal: 'broad',
  // Drives a browser somebody is already signed into, so it inherits every session in it.
  browser: 'moderate',
  // Reads a working tree. Real exposure, no write and no execution.
  filesystem: 'narrow',
  // Decides how much of somebody's quota the machine may spend unattended, but reaches no further.
  warden: 'moderate',
  // BROAD, and it is the only row whose weight is about what comes NEXT. Pairing reaches nothing on the
  // host by itself; what it hands out is a credential that carries every other capability, so weighing it
  // by its own reach would rate it `narrow` and read as the mildest switch on the screen.
  pairing: 'broad',
};

export const capabilityWeight = (capability: DaemonCapability): AccessWeight => CAPABILITY_WEIGHTS[capability];

/** Filled pips out of three, so the mark has a shape and not only a hue. */
const WEIGHT_PIPS: Readonly<Record<AccessWeight, number>> = { broad: 3, moderate: 2, narrow: 1 };
export const weightPips = (weight: AccessWeight): number => WEIGHT_PIPS[weight];

export const ACCESS_WEIGHT_ORDER: readonly AccessWeight[] = ['broad', 'moderate', 'narrow'];

/** The legend, because a mark nobody can decode is decoration. */
const WEIGHT_COPY = {
  broad: { label: 'Widens access most', detail: 'Runs or writes programs on the machine.' },
  moderate: { label: 'Widens access', detail: 'Reaches a signed-in session or spends quota unattended.' },
  narrow: { label: 'Reads only', detail: 'Reads state without changing the machine.' },
} satisfies Record<AccessWeight, { label: string; detail: string }>;

export const weightCopy = (weight: AccessWeight): { label: string; detail: string } => WEIGHT_COPY[weight];

/**
 * What the whole screen is about, stated once and prominently.
 *
 * THIS BROWSER, ON THIS DAEMON — not the machine, and not every device that has ever paired with it.
 * A person reading a permission screen will otherwise take it for the machine's policy and conclude
 * their other devices are covered by what they see here.
 */
export const CAPABILITY_LIST_SCOPE_NOTE =
  'This is what THIS browser may do on THIS machine. Another device paired to the same machine can have different answers, and nothing here describes them.';

/**
 * The sentence a reader is shown for a state that is not a plain yes.
 *
 * `offersUnlock` is the load-bearing field: it is the difference between a control that says "ask the
 * operator" and one that can be opened right here. It is true for exactly one reason — `locked` — and
 * false for `rate-limited`, where a prompt would invite five more wrong guesses at a daemon that has
 * already stopped listening.
 */
export interface GrantGuidance {
  /** How the row should read: an allowed state, a limit somebody chose, or a fault. */
  readonly tone: 'ok' | 'disclosure' | 'limit' | 'fault';
  /** Two or three words for a badge. */
  readonly badge: string;
  /** What is true, and what to do about it. Ends in a full stop; may be two sentences. */
  readonly explanation: string;
  /** Whether an unlock prompt would resolve this. */
  readonly offersUnlock: boolean;
}

/**
 * Every refusal, mapped to what a reader does next.
 *
 * `satisfies Record<GrantRefusal, …>` is the point: the day the protocol declares a new reason, this
 * object stops compiling until somebody decides what it MEANS to a person. An open record would take
 * the new reason silently and render it as a generic failure, which is the dead end this whole
 * feature exists to remove.
 */
const GUIDANCE = {
  /**
   * Allowed. It deliberately does NOT claim the password stood behind it.
   *
   * `granted` is what a `use` axis reads on every machine, password or not, so wording it as "the
   * password stood behind this" states something false on the common setup — and beside a header that
   * already says no password is set, a reader is entitled to believe one of the two is lying.
   */
  granted: { tone: 'ok', badge: 'Allowed', explanation: 'The operator allows this.', offersUnlock: false },
  /**
   * Allowed with nothing behind it — a disclosure, not a refusal.
   *
   * IT DOES NOT REPEAT THE WHOLE DISCLOSURE. That sentence is owed once, and the card states it in the
   * header; restating it under five capabilities × the configure axis prints it five times on one
   * screen, which is exactly the nagging `docs/grants.md` rules out. The row says the short fact and
   * lets the header carry the consequence.
   */
  ungated: {
    tone: 'disclosure',
    badge: 'Allowed',
    explanation: 'Allowed, and no operator password is standing behind it.',
    offersUnlock: false,
  },
  'not-granted': {
    tone: 'limit',
    badge: 'Switched off',
    explanation: 'The operator of this machine switched this off. It is turned back on on the host.',
    offersUnlock: false,
  },
  /**
   * The password gates CHANGING THE SETTINGS of something already on — never turning one on.
   *
   * The old wording ("this needs the operator password") was true of every refusal in #289 and is now
   * false for the one that matters most: a remote caller holding the password still cannot widen a
   * grant. A sentence that implies otherwise invites somebody to type a password expecting authority it
   * does not buy, which is worse than saying nothing.
   */
  locked: {
    tone: 'limit',
    badge: 'Needs the password',
    explanation:
      'Changing this needs the operator password for this machine. Unlock below, then try again. (Switching a capability on is a separate matter and is only ever done at the machine.)',
    offersUnlock: true,
  },
  'rate-limited': {
    tone: 'limit',
    badge: 'Too many tries',
    explanation:
      'Too many wrong operator passwords have been tried, so this daemon has stopped checking them for now. Wait for the lockout to pass, or clear it on the host.',
    offersUnlock: false,
  },
  undetermined: {
    tone: 'fault',
    badge: 'Unknown',
    explanation:
      'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.',
    offersUnlock: false,
  },
} satisfies Record<GrantRefusal, GrantGuidance>;

/**
 * The guidance for one refusal, with the capability named where naming it helps.
 *
 * The two refusals that name a capability are the two a person can act on per capability. The other
 * four are facts about the machine, and repeating "the agent fleet" inside a sentence about a
 * daemon that cannot read its own document would make five rows say the same thing five times.
 */
export function grantGuidance(refusal: GrantRefusal, capability?: DaemonCapability): GrantGuidance {
  const base = GUIDANCE[refusal];
  if (capability === undefined) return base;
  if (refusal === 'not-granted')
    return {
      ...base,
      explanation: `The operator of this machine switched off ${capabilityNoun(capability)} for callers that are not on the host. It is turned back on on the host.`,
    };
  if (refusal === 'locked')
    return {
      ...base,
      explanation: `Changing ${capabilityNoun(capability)} needs the operator password for this machine. Unlock below, then try again.`,
    };
  return base;
}

/**
 * The reason ONE axis's control reads the way it does, including when it cannot be moved.
 *
 * THREE CASES, and the middle one is the bug a naive version ships. An axis can be ALLOWED right now
 * and still not changeable from this browser — the operator withheld `configure`, which is also the
 * lock on re-granting the capability — and reusing the `configure` refusal there tells a person their
 * `use` axis is switched off when it is on. That sentence sends them to the host to turn on something
 * that is already on, so this case gets its own wording: what is true (they may use it) and what is
 * not (they may not change it here).
 */
export function axisGuidance(entry: CapabilityGrantView, axis: CapabilityAxis, changeable: boolean): GrantGuidance {
  const own = grantGuidance(axisRefusal(entry, axis), entry.capability);
  if (changeable) return own;
  if (!axisAllowed(entry, axis)) return own;
  return {
    tone: 'limit',
    badge: 'Fixed on the host',
    explanation: `This browser may use ${capabilityNoun(entry.capability)} and may not change this. The operator did not grant it permission to change ${capabilityNoun(entry.capability)}, which is also what stops it re-granting itself the capability — so this is changed at the machine.`,
    offersUnlock: false,
  };
}

/** The effective answer for one axis, so a row reads its state from one place. */
export const axisAllowed = (entry: CapabilityGrantView, axis: CapabilityAxis): boolean =>
  axis === 'use' ? entry.use : entry.configure;

/** The reason that answer reads the way it does. */
export const axisRefusal = (entry: CapabilityGrantView, axis: CapabilityAxis): GrantRefusal =>
  axis === 'use' ? entry.useRefusal : entry.configureRefusal;

/**
 * Whether the operator wrote this capability down, or the product answered for them.
 *
 * A default is not a weaker answer, and this deliberately does not read as a warning: it is the same
 * provenance column `fyd --print-config` gives every other value, and the question it answers is
 * "which of these did I choose" — which is what somebody reading a permission report is usually
 * actually asking.
 */
export const originNote = (entry: CapabilityGrantView): string =>
  entry.origin === 'config file'
    ? 'Written down by the operator of this machine.'
    : 'Not written down; this is the product default.';

/** One axis change, as the partial patch the wire expects. */
export const grantPatch = (capability: DaemonCapability, axis: CapabilityAxis, next: boolean): GrantsPatch =>
  ({ [capability]: { [axis]: next } }) as GrantsPatch;

/**
 * Whether this caller may turn this capability ON at all.
 *
 * ## LOCALITY DECIDES THIS, AND NOTHING ELSE CAN
 *
 * A remote caller may never widen a grant — no operator password, no unlock, no credential changes it.
 * So this is not a question about what to prompt for; it is a question about whether to render a
 * control at all. A switch that always fails is worse than no switch: it teaches somebody the product
 * is broken rather than that the machine decided.
 *
 * READ STRAIGHT OFF THE WIRE, deliberately, rather than inferred from the posture. The daemon is
 * enforcing this rule and now states it per capability, so a second copy of the rule in the browser is
 * a second thing that can disagree with it — and the disagreement would show up as a control that
 * either fails on press or is missing when it should work.
 */
export function mayGrantCapability(entry: CapabilityGrantView): boolean {
  return entry.mayGrant;
}

/**
 * Whether this exact change still needs an unlock.
 *
 * NARROWED BY THE RULE CHANGE. Widening is now decided by locality rather than by the password, so the
 * only change an unlock is ever needed for is altering the settings of a capability that is already on
 * — which is `configure` on a machine with a password set. Turning an axis OFF is never gated: it is
 * what somebody does during an incident, and a prompt between a person and shutting a door is a
 * liability.
 */
export function grantChangeNeedsUnlock(view: GrantsView, capability: DaemonCapability, next: boolean): boolean {
  if (!next || !view.passwordSet) return false;
  const entry = view.capabilities.find(candidate => candidate.capability === capability);
  return entry !== undefined;
}

/** Whether the operator's document already records this axis the way a change would set it. */
export function grantAlreadyReads(
  view: GrantsView,
  capability: DaemonCapability,
  axis: CapabilityAxis,
  next: boolean,
): boolean {
  const entry = view.capabilities.find(candidate => candidate.capability === capability);
  return entry !== undefined && entry.granted[axis] === next;
}

// ─── refusals arriving from an ordinary route ──────────────────────────────────────────────────

/**
 * What an error carries about itself, read structurally rather than by class.
 *
 * DELIBERATELY NOT `instanceof`. Three different error types reach this — the protocol client's
 * `FyHttpError`, the PWA's own `DaemonResponseError`, and whatever a future transport throws — and
 * two copies of a class in one install would make an `instanceof` check quietly false. The two
 * fields are the whole contract, so they are what is read.
 */
interface HttpFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

/**
 * Every `grant_*` code a governed route can answer with, mapped back to the reason it names.
 *
 * The dispatcher composes these from the refusal itself (`grant_` plus the reason with dashes turned
 * into underscores), so this table is the browser's half of that spelling and is asserted against
 * the enum by a test. `grant_forbidden` and `grants_undetermined` come from the grant ROUTES rather
 * than from the guard, and they are here because a reader meets them the same way.
 */
const REFUSAL_BY_CODE: Readonly<Record<string, GrantRefusal>> = {
  grant_not_granted: 'not-granted',
  grant_locked: 'locked',
  grant_rate_limited: 'rate-limited',
  grant_undetermined: 'undetermined',
  grants_undetermined: 'undetermined',
  grant_forbidden: 'not-granted',
};

/**
 * A refusal an ordinary route answered with, or `null` when this failure is about something else.
 *
 * `detail` is the DAEMON'S OWN SENTENCE, kept whole. It already names the command a human runs,
 * composed by the layer that knows what this product's client is called — a browser that replaced it
 * with its own wording would either repeat it or contradict it. The guidance beside it is what the
 * browser adds: the tone, the badge, and whether an unlock is on offer.
 */
export interface GrantRefusalNotice {
  readonly refusal: GrantRefusal;
  readonly detail: string;
  readonly guidance: GrantGuidance;
}

export function grantRefusalNotice(error: unknown): GrantRefusalNotice | null {
  if (error === null || typeof error !== 'object') return null;
  const failure = error as HttpFailure;
  if (typeof failure.code !== 'string') return null;
  const refusal = REFUSAL_BY_CODE[failure.code];
  if (refusal === undefined) return null;
  // A code is not enough on its own: `grant_rate_limited` is also how the UNLOCK route refuses, and
  // that is a 429 about a password rather than a 403 about a capability. Both statuses are accepted
  // because both mean the same thing to the control that is disabled.
  if (failure.status !== 403 && failure.status !== 429 && failure.status !== 503) return null;
  const detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : '';
  return { refusal, detail, guidance: grantGuidance(refusal) };
}

// ─── the unlock exchange ───────────────────────────────────────────────────────────────────────

/**
 * An unlock, stamped with the daemon that minted it.
 *
 * The stamp is not decoration. One browser can be paired to several daemons, and a token is proof
 * against exactly one of them; presenting daemon A's unlock to daemon B would be a credential
 * crossing a machine boundary, which is the failure this repository keys everything by daemon to
 * prevent. `expiresAtMs` is held as the instant rather than a duration so a screen left open cannot
 * keep believing a token is live.
 */
export interface HeldUnlock {
  readonly daemonId: DaemonId;
  readonly token: string;
  readonly expiresAtMs: number;
}

/** The unlock to send with a change, or `undefined` when there is none this daemon can use now. */
export function usableUnlock(held: HeldUnlock | null, daemonId: DaemonId, nowMs: number): string | undefined {
  if (held === null || held.daemonId !== daemonId || held.expiresAtMs <= nowMs) return undefined;
  return held.token;
}

/** Whole seconds left on a held unlock, floored at zero, for a countdown a reader can act on. */
export function unlockSecondsRemaining(held: HeldUnlock | null, daemonId: DaemonId, nowMs: number): number {
  if (held === null || held.daemonId !== daemonId) return 0;
  return Math.max(0, Math.ceil((held.expiresAtMs - nowMs) / 1_000));
}

/**
 * Why an unlock attempt failed, in the words the daemon used, with the one number a person needs.
 *
 * ATTEMPTS REMAINING IS SHOWN, because a limiter a person cannot see is a limiter that looks like a
 * broken daemon. It is read from the daemon's own sentence rather than counted here: the count is
 * per-daemon state and a browser that kept its own would disagree with the machine the moment two
 * tabs were open. When the sentence carries no number, the field is absent rather than guessed.
 */
export interface OperatorUnlockFailure {
  readonly message: string;
  /** Whether typing another password could succeed. False while the daemon is not checking. */
  readonly retryable: boolean;
  readonly attemptsRemaining?: number;
}

const ATTEMPTS_PATTERN = /(\d+)\s+attempts?\s+remaining/u;

export function operatorUnlockFailure(error: unknown): OperatorUnlockFailure {
  const failure = (error === null || typeof error !== 'object' ? {} : error) as HttpFailure;
  const daemonSaid = typeof failure.message === 'string' && failure.message !== '' ? failure.message : '';
  const code = typeof failure.code === 'string' ? failure.code : '';
  if (code === 'grant_rate_limited')
    return {
      message: daemonSaid === '' ? GUIDANCE['rate-limited'].explanation : daemonSaid,
      retryable: false,
      attemptsRemaining: 0,
    };
  if (code === 'grant_no_password')
    return {
      message: daemonSaid === '' ? 'This machine has no operator password, so there is nothing to unlock.' : daemonSaid,
      retryable: false,
    };
  if (code === 'grant_wrong_password') {
    const found = ATTEMPTS_PATTERN.exec(daemonSaid);
    const parsed = found?.[1] === undefined ? undefined : Number(found[1]);
    return {
      message: daemonSaid === '' ? 'That is not this machine’s operator password.' : daemonSaid,
      retryable: true,
      ...(parsed === undefined || Number.isNaN(parsed) ? {} : { attemptsRemaining: parsed }),
    };
  }
  return {
    message: daemonSaid === '' ? 'The unlock could not be completed.' : daemonSaid,
    retryable: true,
  };
}

/** The limiter, stated before anybody has spent a try, so five is a known budget rather than a surprise. */
export const UNLOCK_LIMIT_NOTE = `Five wrong passwords and this daemon stops checking for fifteen minutes. It counts per machine, not per browser, so a colleague’s wrong guesses spend the same ${String(GRANT_UNLOCK_MAX_ATTEMPTS)}.`;
