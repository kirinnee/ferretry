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
};

export const capabilityNoun = (capability: DaemonCapability): string => CAPABILITY_NOUNS[capability];

/** The heading a capability's row carries. Title case, because it labels a group of controls. */
const CAPABILITY_LABELS: Readonly<Record<DaemonCapability, string>> = {
  fleet: 'Agent fleet',
  terminal: 'Session terminals',
  browser: 'Browser',
  filesystem: 'Session files',
  warden: 'Fleet supervision',
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
  'No operator password is set, so any paired device can change this machine’s fleet and settings.';

/** The counterpart, so a machine WITH the layer on says so rather than staying silent about it. */
export const PASSWORD_SET_DISCLOSURE =
  'An operator password is set, so turning any of these on from off this host needs it. Turning one off never does.';

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
  granted: {
    tone: 'ok',
    badge: 'Allowed',
    explanation: 'The operator allowed this, and the operator password stood behind it.',
    offersUnlock: false,
  },
  ungated: {
    tone: 'disclosure',
    badge: 'Allowed',
    explanation: `Allowed, and nothing is standing behind it. ${NO_PASSWORD_DISCLOSURE}`,
    offersUnlock: false,
  },
  'not-granted': {
    tone: 'limit',
    badge: 'Switched off',
    explanation: 'The operator of this machine switched this off. It is turned back on on the host.',
    offersUnlock: false,
  },
  locked: {
    tone: 'limit',
    badge: 'Needs the password',
    explanation: 'This needs the operator password for this machine. Unlock below, then try again.',
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
    explanation: `This browser may use ${capabilityNoun(entry.capability)} and may not change this. The operator did not grant it permission to change ${capabilityNoun(entry.capability)}, which is also what stops it re-granting itself the capability — so this is changed on the host, or by unlocking with the operator password.`,
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
 * Whether this exact change needs an unlock before it will be accepted.
 *
 * ONLY WIDENING, and only with a password set. Turning an axis off is what somebody does during an
 * incident, so a prompt between them and shutting a door would be a liability; turning one on is the
 * single change that gives a remote browser more than it had. With no password there is nothing to
 * unlock — such a change is a host act and the daemon says so — so this is false there too, and the
 * refusal that comes back is rendered rather than pre-empted with a prompt that could not help.
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
