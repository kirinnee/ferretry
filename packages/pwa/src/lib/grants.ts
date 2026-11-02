/**
 * WHAT THE BROWSER SAYS WHEN THE OPERATOR HAS SAID NO.
 *
 * The daemon already decides everything; this module decides nothing. Its whole job is to turn the
 * two things the daemon hands over — a `GrantRefusal` on the grant view, and a `grant_*` code on a
 * 403 from an ordinary route — into a sentence naming the NEXT STEP, plus the one bit of state a
 * control needs: whether a passkey step-up would help.
 *
 * ## WHY THE COPY IS HERE AND NOT AT EACH CONTROL
 *
 * A greyed control with no explanation is the dead end this feature exists to remove, and the way
 * that dead end comes back is one surface at a time: the Fleet tab words a refusal, then the Files
 * pane words it differently, then the terminal deck shows the raw message. `docs/grants.md` is the
 * contract and this is its single browser-side rendering, so a refusal reads the same wherever it
 * lands and a new refusal reason cannot be added without a sentence being written for it.
 *
 * ## THE STEP-UP IS THE DAEMON'S, NOT THIS MODULE'S
 *
 * A governed caller doing something dangerous needs a recent passkey step-up (`docs/design/zero-trust.md`).
 * The daemon remembers it, the carrier asks for it and retries once, and this module holds nothing: no
 * token, no cache, no clock. What lives here is the sentence that says `step-up-required` in plain words.
 *
 * ## NARROWING IS NEVER PRE-EMPTED BY THE BROWSER
 *
 * Turning an axis OFF is what somebody does during an incident. A governed caller's narrowing needs one
 * passkey touch like any other configure act, but the browser never pre-empts it: the press is sent and
 * the daemon's own answer decides.
 */

import {
  type CapabilityAxis,
  type CapabilityGrantView,
  type DaemonCapability,
  type GrantRefusal,
  type GrantsPatch,
  type GrantsView,
  STEP_UP_REQUIRED_CODE,
  type StepUpDemand,
} from '@ferretry/protocol';

/**
 * What a passkey confirmation covers, in one plain sentence with no secret to type.
 *
 * Said once, beside the one button that asks for it, so the screen never teaches that a step-up is a
 * secret to type: it is a touch on this device, it lasts a short while, and it never widens.
 */
export const STEP_UP_NOTE =
  'Changing how a capability behaves, or opening a terminal, the browser, a pairing code, a stored secret or sharing a catalog, asks you to confirm with your passkey on this device. It covers this open copy of the app for a short while and never turns anything on that was switched off.';

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
  filesystem: 'the project filesystem',
  warden: 'fleet supervision',
  pairing: 'device pairing',
  secrets: 'the secret store',
  sharing: 'catalog sharing',
};

export const capabilityNoun = (capability: DaemonCapability): string => CAPABILITY_NOUNS[capability];

/** The heading a capability's row carries. Title case, because it labels a group of controls. */
const CAPABILITY_LABELS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'Agent fleet',
  terminal: 'Session terminals',
  browser: 'Browser',
  filesystem: 'Project filesystem',
  warden: 'Fleet supervision',
  pairing: 'Device pairing',
  secrets: 'Secrets',
  sharing: 'Sharing',
};

export const capabilityLabel = (capability: DaemonCapability): string => CAPABILITY_LABELS[capability];

/**
 * What a person is confirming, as a verb phrase that finishes "Confirm with your passkey to …".
 *
 * ONE TABLE, written once, beside the labels it sits with. Every `use` is listed even though only four
 * of them ever ask for a step-up, so the function is total and a capability added later cannot reach a
 * prompt with a blank where its act should be (a test pins the table to `DAEMON_CAPABILITIES`).
 */
const USE_ACTS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'use the agent fleet',
  terminal: 'open a terminal',
  browser: 'open the remote browser',
  filesystem: 'use the project filesystem',
  warden: 'use fleet supervision',
  pairing: 'add or manage a paired device',
  secrets: 'run a command with a stored secret',
  sharing: 'manage or export a shared catalog',
};

/**
 * The acts that add access to a machine, which always ask for a passkey of their own (owner decision
 * 2026-10-14). Named exactly, because "add or manage a paired device" is too vague a thing to confirm
 * when what the person is approving is another device getting into this machine.
 */
const ACCESS_ACTS: Readonly<Record<NonNullable<StepUpDemand['act']>, string>> = {
  'add-device': 'add a device',
  'widen-device': 'give another device more access',
  'enable-agent-control': 'let agents control that again',
  'loosen-config': 'put a configuration change into effect',
  'clone-secrets': 'copy secrets to another machine',
  'loosen-security': 'make this machine ask for your passkey less often',
  'catalog-install': 'install something from a shared catalog',
  'share-catalog': 'share a catalog with someone',
  'share-link': 'publish one item as a link anyone holding it can install',
  'add-2fa-key': 'save automatic 2FA codes for an account',
  'allow-profile-targets': 'let paste rules paste into programs in your own profile',
  'approve-task-plan': "let Ferretry sign in for a ferret with an account's password",
  'approve-sign-in-rule':
    "let Ferretry sign in for the ferrets a rule names with an account's password, until the rule ends",
  'resume-cut-off': 'bring back a ferret you cut off',
  'approve-paste-rule': 'let Ferretry paste a sealed copy for ferrets without asking, under this one paste rule',
};

/**
 * The act a step-up demand stands for. An act the daemon named is said as itself; otherwise a `configure`
 * is always a change to that capability's settings.
 */
export const stepUpAct = (demand: StepUpDemand): string => {
  if (demand.act !== undefined) return ACCESS_ACTS[demand.act];
  return demand.axis === 'use'
    ? USE_ACTS[demand.capability]
    : `change the settings for ${capabilityNoun(demand.capability)}`;
};

/** What a prompt says when the daemon named no act: the machine is still named, and the act is "this change". */
export const STEP_UP_FALLBACK_ACT = 'make this change';

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
  filesystem: 'Reading project files, registering host folders, and running Git init or clone.',
  warden: 'Supervision status, sweeps, and how much quota the daemon may spend unattended.',
  pairing:
    'Minting pairing codes that let another device reach this machine. A device that can mint credentials for more devices turns one stolen phone into standing access, so switching this off is the one decision a browser can never undo.',
  secrets:
    'Runs a command with a stored secret in its environment — code on this machine; and sets or deletes stored secrets.',
  sharing:
    'Making catalogs of this machine’s skills and MCP setups and exporting them as signed files, which makes this machine vouch for what they hold. Sharing with named people comes in a later update.',
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
 * THE ONE-WAY DOOR, stated wherever a browser can see a switch.
 *
 * ## ONLY THE MACHINE'S OWN COMMAND LINE WIDENS, AND NO CREDENTIAL CAN BUY IT
 *
 * A browser can never turn a capability ON — not after a passkey step-up, and not when it runs on the
 * machine itself: "at the machine" means the host's admin token over loopback, which a browser never
 * holds. The step-up gates changing the settings of something already on. Any copy claiming a credential
 * lets a paired device widen a grant would be false, and false in the dangerous direction.
 *
 * Turning something OFF from a browser is therefore a door that closes behind you: the only way back is
 * the command line at the machine. That is worth saying BEFORE the click rather than in a document
 * afterwards.
 */
export const REMOTE_ONE_WAY_NOTE =
  'This browser can switch these off but never back on, even on the machine itself; turning one on is done with `fy daemon config set` at the machine.';

/**
 * What switching a capability off ALSO switches off, when that is the thing somebody came here to do.
 *
 * ONE ENTRY TODAY, AND IT IS NOT DECORATION. A capability with no entry (`sharing` in phase 1) stops nothing
 * beyond its own job, so its switch says nothing extra. Somebody reaches for `pairing` off because a phone was
 * stolen — and that same switch refuses `DELETE /v1/pair/devices/:deviceId`, because both carry
 * `pairing.use`. So the coarse switch disables the remedy the person is reaching for it to apply, and
 * the order that works has to be on the control rather than in `docs/grants.md`: a document is read
 * afterwards, the lockout happens at the click.
 *
 * Keyed per capability rather than written into the sentence below, because the next capability whose
 * switch disables its own remedy needs its own sentence and no generic wording could carry it. See
 * `docs/grants.md`, "Before you add capability seven".
 */
const COARSE_SWITCH_ALSO_STOPS: Readonly<Partial<Record<DaemonCapability, string>>> = {
  pairing:
    'It also stops this device revoking a paired one, because both are the same permission — so if you are shutting out a lost or stolen device, revoke that device FIRST and switch this off afterwards.',
};

/**
 * The sentence a reader is shown before they close a door only the machine’s command line can reopen.
 *
 * It carries the way back — the host command — and, where the switch also disables the remedy, the
 * ordering that avoids locking yourself out of it.
 */
export function remoteRevokeWarning(capability: DaemonCapability, clientName = 'fy'): string {
  const alsoStops = COARSE_SWITCH_ALSO_STOPS[capability];
  return `Switching off ${capabilityNoun(capability)} from this device cannot be undone from here — turning it back on has to be done at the machine, with \`${clientName} daemon config set ${capability} --use\`.${alsoStops === undefined ? '' : ` ${alsoStops}`}`;
}

/** What an off capability says to a caller that may not turn it on: a statement with a remedy. */
export function grantOnlyAtMachine(capability: DaemonCapability, clientName = 'fy'): string {
  return `${capabilityLabel(capability)} is switched off, and can only be switched on at the machine, with \`${clientName} daemon config set ${capability} --use\` — a passkey does not, even in a browser there.`;
}

/**
 * The host command that widens ONE device, the only remedy for a widen this browser may not make.
 *
 * `<device>` is a placeholder on purpose: a device's name is untrusted text, and a command line is the
 * one place it must not be spliced into unquoted.
 */
export const deviceGrantCommand = (capability: DaemonCapability, axis: CapabilityAxis, clientName = 'fy'): string =>
  `${clientName} device grant <device> ${capability} --${axis}`;

// ─── how this browser reached this daemon ───────────────────────────────────────────────────────

/**
 * HOW the limits apply to this browser, which is a different question from WHICH ones.
 *
 * ## EVERY BROWSER IS GOVERNED, AND THE DAEMON SAYS SO
 *
 * A browser is a paired device wherever it runs. A page on `http://127.0.0.1` is governed exactly like
 * a phone on the relay: only the host's admin token over loopback — the CLI, never a browser — is the
 * owner at the machine. So the live answer is `governed`, taken from `GrantsView.governed` and never
 * from the page's address, `location.hostname` or the daemon's `baseUrl`. Nothing in this module reads
 * any of them, and nothing may.
 *
 * ## `unknown` IS A REAL STATE, NOT A MISSING ONE
 *
 * No answer, or an answer that says "not governed" to a browser, is not something this app can explain,
 * and the friendly reading is the wrong one: it would tell a person their limits do not apply. So the
 * screen says it cannot tell and treats the limits as applying — the safe reading — in keeping with the
 * rest of this feature, where damaged state is never read as empty state.
 */
export type ConnectionPosture = 'governed' | 'unknown';

/** The posture, from the daemon's own account of the request. Only an explicit `true` is governed. */
export function connectionPosture(governed: boolean | undefined): ConnectionPosture {
  return governed === true ? 'governed' : 'unknown';
}

/** What each posture means for the whole screen, in the words a person would use about themselves. */
export interface PostureCopy {
  readonly badge: string;
  readonly headline: string;
  readonly detail: string;
  readonly tone: 'ok' | 'disclosure' | 'limit' | 'fault';
}

const POSTURE_COPY = {
  governed: {
    badge: 'Governed',
    headline: 'The operator’s limits apply to this browser, even when it runs on the machine itself.',
    detail:
      'Every capability below is open only because the operator allowed it, and changing one, or opening a terminal, the browser, a pairing code, a stored secret or sharing a catalog, asks you to confirm with your passkey.',
    tone: 'disclosure',
  },
  unknown: {
    badge: 'Cannot tell',
    headline: 'This daemon did not say how it saw this connection, so Ferretry will not claim either way.',
    detail:
      'Until the daemon reports it, treat the limits below as applying to this browser — the safe reading, not the flattering one.',
    tone: 'fault',
  },
} satisfies Record<ConnectionPosture, PostureCopy>;

export const postureCopy = (posture: ConnectionPosture): PostureCopy => POSTURE_COPY[posture];

/**
 * Why THIS capability is open right now — the per-row version of the posture.
 *
 * `granted` is open because the operator allowed it. `step-up` is a row that is allowed in principle and
 * waits on a passkey confirmation from this device. The rest are the reasons the daemon already gives.
 */
export type OpenReason = 'granted' | 'step-up' | 'closed' | 'unknown';

export function openReason(entry: CapabilityGrantView, axis: CapabilityAxis, posture: ConnectionPosture): OpenReason {
  if (axisRefusal(entry, axis) === 'step-up-required') return 'step-up';
  if (!axisAllowed(entry, axis)) return 'closed';
  if (posture === 'unknown') return 'unknown';
  return 'granted';
}

/** The short mark a row carries, so five rows do not all read "allowed". */
const OPEN_REASON_LABELS = {
  granted: 'Open — granted',
  'step-up': 'Open — after your passkey',
  closed: 'Closed',
  unknown: 'Open — reason unknown',
} satisfies Record<OpenReason, string>;

export const openReasonLabel = (reason: OpenReason): string => OPEN_REASON_LABELS[reason];

// ─── how much a capability hands over ──────────────────────────────────────────────────────────

/**
 * HOW MUCH ACCESS THIS CAPABILITY IS, so the dangerous ones do not look like the mild ones.
 *
 * Five rows that read alike make a person weigh a read-only capability and one that writes the host the
 * same. `filesystem` is broad because its configure axis can create folders and run Git, even though its
 * use axis only reads project files. The weight is a property of the MOST the capability reaches — the
 * reasoning already written down in `CAPABILITY_REACH` — so it is declared per capability rather than
 * derived from whether it happens to be on.
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
  // Reads project files and can create host folders by running Git init or clone.
  filesystem: 'broad',
  // Decides how much of somebody's quota the machine may spend unattended, but reaches no further.
  warden: 'moderate',
  // BROAD, and it is the only row whose weight is about what comes NEXT. Pairing reaches nothing on the
  // host by itself; what it hands out is a credential that carries every other capability, so weighing it
  // by its own reach would rate it `narrow` and read as the mildest switch on the screen.
  pairing: 'broad',
  // Running a command is code execution on the host, with credentials in its environment: the same tier
  // as a terminal, whatever the secret store holds.
  secrets: 'broad',
  // Publishes this machine's own skills and MCP setups to people outside it, signed as this machine. What it
  // hands over is material the owner chose, not control of the host, so it weighs less than pairing.
  sharing: 'moderate',
};

export const capabilityWeight = (capability: DaemonCapability): AccessWeight => CAPABILITY_WEIGHTS[capability];

/** Filled pips out of three, so the mark has a shape and not only a hue. */
const WEIGHT_PIPS: Readonly<Record<AccessWeight, number>> = { broad: 3, moderate: 2, narrow: 1 };
export const weightPips = (weight: AccessWeight): number => WEIGHT_PIPS[weight];

/** Most access first, so a legend and a sorted list read the same way round. */
const ACCESS_WEIGHT_ORDER: readonly AccessWeight[] = ['broad', 'moderate', 'narrow'];

/**
 * The weights a given set of capabilities ACTUALLY carries, most access first.
 *
 * THE LEGEND IS DERIVED RATHER THAN LISTED, because the two drift the moment a weight is reassigned.
 * `filesystem` moving to `broad` emptied the `narrow` class, and a legend built from the fixed triple
 * went on advertising "Reads only" with no row beneath it — sending a reader hunting for the read-only
 * capability the screen was promising. A key for a class nobody is in is worse than no key: it is a
 * claim about the machine that no row supports.
 *
 * It takes the capabilities being RENDERED, not the whole enum, so a daemon that reported three rows
 * gets a legend for those three. `AccessWeight` deliberately keeps all three members — a future
 * capability may well be `narrow` — and this is what stops an unused member reaching the screen.
 */
export function accessWeightsPresent(capabilities: readonly DaemonCapability[]): readonly AccessWeight[] {
  const present = new Set(capabilities.map(capabilityWeight));
  return ACCESS_WEIGHT_ORDER.filter(weight => present.has(weight));
}

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
 * `offersStepUp` is the load-bearing field: it is the difference between a control that says "ask the
 * operator" and one that can be opened right here with a passkey touch. It is true for exactly one
 * reason — `step-up-required`.
 */
export interface GrantGuidance {
  /** How the row should read: an allowed state, a limit somebody chose, or a fault. */
  readonly tone: 'ok' | 'disclosure' | 'limit' | 'fault';
  /** Two or three words for a badge. */
  readonly badge: string;
  /** What is true, and what to do about it. Ends in a full stop; may be two sentences. */
  readonly explanation: string;
  /** Whether a passkey step-up would resolve this. */
  readonly offersStepUp: boolean;
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
  granted: { tone: 'ok', badge: 'Allowed', explanation: 'The operator allows this.', offersStepUp: false },
  'not-granted': {
    tone: 'limit',
    badge: 'Switched off',
    explanation: 'The operator of this machine switched this off. It is turned back on on the host.',
    offersStepUp: false,
  },
  /**
   * The machine allows it and THIS device was never given it. A passkey does not help: the next step
   * is widening this one device, at the machine or from a device that holds the capability and
   * `pairing.configure`.
   */
  'device-not-granted': {
    tone: 'limit',
    badge: 'Not given to this device',
    explanation:
      'The machine allows this, but this device has not been given it. Widen this device at the machine, or from a device that holds it and can configure pairing.',
    offersStepUp: false,
  },
  /**
   * A passkey touch on THIS device stands between the person and a dangerous act. It never buys
   * widening — no browser can turn a capability on.
   */
  'step-up-required': {
    tone: 'limit',
    badge: 'Needs your passkey',
    explanation: 'This needs your passkey. Confirm on this device and it goes ahead.',
    offersStepUp: true,
  },
  undetermined: {
    tone: 'fault',
    badge: 'Unknown',
    explanation:
      'This daemon could not read its own grant document, so it is refusing everything governed by it. Nothing is broken about this browser; the document on the host needs repairing.',
    offersStepUp: false,
  },
} satisfies Record<GrantRefusal, GrantGuidance>;

/**
 * The guidance for one refusal, with the capability named where naming it helps.
 *
 * The two refusals that name a capability are the two a person can act on per capability. The other
 * two are facts about the machine, and repeating "the agent fleet" inside a sentence about a
 * daemon that cannot read its own document would make five rows say the same thing five times.
 */
export function grantGuidance(refusal: GrantRefusal, capability?: DaemonCapability): GrantGuidance {
  const base = GUIDANCE[refusal];
  if (capability === undefined) return base;
  if (refusal === 'not-granted')
    return {
      ...base,
      explanation: `The operator of this machine switched off ${capabilityNoun(capability)} for paired devices, this browser included. It is turned back on at the machine with \`fy\`.`,
    };
  if (refusal === 'device-not-granted')
    return {
      ...base,
      explanation: `This machine allows ${capabilityNoun(capability)}, but this device has not been given it. Widen this device at the machine with \`${deviceGrantCommand(capability, 'use')}\`, or from a device that holds it and can configure pairing.`,
    };
  if (refusal === 'step-up-required')
    return {
      ...base,
      explanation: `Using or changing ${capabilityNoun(capability)} from here needs your passkey. Confirm on this device and it goes ahead.`,
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
    offersStepUp: false,
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
 * Only the host's admin token over loopback may widen a grant, and a browser never holds it — so for a
 * browser this reads false, even on the machine itself, and no passkey step-up changes that. It is not
 * a question about what to prompt for; it is a question about whether to render a control at all. A
 * switch that always fails is worse than no switch: it teaches somebody the product is broken rather
 * than that the machine decided.
 *
 * READ STRAIGHT OFF THE WIRE, deliberately, rather than inferred from the posture. The daemon is
 * enforcing this rule and states it per capability, so a second copy of the rule in the browser is a
 * second thing that can disagree with it.
 */
export function mayGrantCapability(entry: CapabilityGrantView): boolean {
  return entry.mayGrant;
}

/**
 * Whether the daemon would accept THIS browser changing either axis of this capability at all.
 *
 * THE DAEMON'S RULE, restated exactly: a governed caller must already hold `use` and `configure` on a
 * capability to touch either of its axes, because an operator who said the UI may not configure
 * `terminal` is also saying the UI may not re-grant itself `terminal`. A browser is always governed;
 * an ungoverned caller (the CLI) has nothing to hold, so the per-capability gate adds nothing for it.
 * The passkey step-up is deliberately not part of this: it can always be obtained on the spot, so it
 * never makes a control unchangeable.
 */
export const grantChangeable = (view: GrantsView, entry: CapabilityGrantView): boolean =>
  !view.governed || (entry.granted.use && entry.granted.configure);

/**
 * Who the limits on this screen actually apply to, in one sentence that cannot be wrong for a real
 * configuration.
 */
const GRANT_SCOPE_NOTES = {
  governed: 'this-browser',
  unknown: 'cannot-tell',
} satisfies Record<ConnectionPosture, string>;

/** The stable mark a test and a screenshot can name the branch by. */
export const grantScopeKey = (posture: ConnectionPosture): string => GRANT_SCOPE_NOTES[posture];

export function grantScopeNote(posture: ConnectionPosture): string {
  if (posture === 'governed')
    return 'These apply to this browser, because a paired device is governed wherever it runs, on the machine itself included.';
  return 'This daemon did not say how it saw this connection, so treat these as limits that apply to this browser — the safe reading.';
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
  [STEP_UP_REQUIRED_CODE]: 'step-up-required',
  grant_device_not_granted: 'device-not-granted',
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
 * browser adds: the tone, the badge, and whether a passkey step-up is on offer.
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
  // A grant refusal is a 403, or a 503 when the daemon cannot read its own grant document.
  if (failure.status !== 403 && failure.status !== 503) return null;
  const detail = typeof failure.message === 'string' && failure.message !== '' ? failure.message : '';
  return { refusal, detail, guidance: grantGuidance(refusal) };
}

/**
 * Which axes THIS device's own grant withholds although the machine allows them, as one sentence.
 *
 * `null` when the caller is not a governed device (`deviceGranted` is absent on the host) or when its
 * grant withholds nothing the machine allows. It names only what the device grant adds to the daemon-wide
 * answer, because the daemon-wide refusal already has its own sentence.
 */
export function deviceGrantNote(entry: CapabilityGrantView, clientName = 'fy'): string | null {
  const device = entry.deviceGranted;
  if (device === undefined) return null;
  const withheld = (['use', 'configure'] as const).filter(axis => entry.granted[axis] && !device[axis]);
  const first = withheld[0];
  if (first === undefined) return null;
  return `This device has not been given ${withheld.map(axisLabel).join(' or ').toLowerCase()} of ${capabilityNoun(entry.capability)}, although the machine allows it. Widen this device at the machine with \`${deviceGrantCommand(entry.capability, first, clientName)}\`, or from a device that holds it and can configure pairing.`;
}
