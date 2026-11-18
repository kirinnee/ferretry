/**
 * What the Security panel and the post-pairing nudge need that is not a component: browser support,
 * the sentence each refusal becomes, how a passkey is named, and the per-machine "not now" memory.
 *
 * A passkey has no name on the wire (`PasskeyView` is id, origin, created-at), so the label is derived
 * from those two facts and never invented.
 */

import { type StepUpRefusal, stepUpRefusalCode } from '@ferretry/core-gate/contract';
import { HOSTED_APP_ORIGIN } from '../../contract/index.ts';
import { FyHttpError } from '../shell-grants.ts';
import { PasskeyCeremonyError, passkeySentence } from '@ferretry/app';

/** What changing a setting costs, said where a person decides to add a passkey (docs/design/zero-trust.md B2). */
export const PASSKEY_COST_SENTENCE =
  'Changing settings, opening a terminal or the browser, and adding a device ask you to confirm with a passkey on this device.';

/** Whether this page can run a passkey ceremony at all: the API exists and the address is a secure one. */
export function webAuthnSupported(
  environment: { readonly hasCredentialApi: boolean; readonly secureContext: boolean } = {
    hasCredentialApi: typeof PublicKeyCredential !== 'undefined',
    secureContext: typeof window !== 'undefined' && window.isSecureContext,
  },
): boolean {
  return environment.hasCredentialApi && environment.secureContext;
}

/** The one sentence for a browser that cannot hold passkeys, with the address it was asked at. */
export const unsupportedSentence = (origin: string): string =>
  `This browser cannot use passkeys at ${origin}. Passkeys need a secure address (HTTPS or localhost) and a browser that supports them.`;

/** What adding a passkey asks of a device that already holds one, naming the machine it is for. */
export const confirmExistingSentence = (machine: string): string =>
  `Adding a passkey for ${machine} asks you to confirm with a passkey this device already holds first.`;

/** One shell-safe word: the only shape of client name this screen will paste into a command. */
const SAFE_CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

const PASSKEY_WINDOW_PLACEHOLDER = 'fy passkey window <this device>';

/**
 * The exact command the owner runs AT THE MACHINE to open this device's passkey window (`docs/pairing.md`).
 *
 * A device's name is text the DEVICE chose, and this string is made to be pasted into a shell, so the name is
 * always one single-quoted word (a `'` becomes `'\''`), and a name with a control character, a newline or a leading
 * `-` (which the client would read as an option) is not printed at all: the device's id, which is a fixed-shape token,
 * stands in. The client accepts either.
 *
 * The program is the one THIS machine says it runs (`clientName`: `fy5` on a preview): a bare `fy` would reach whatever
 * other daemon the owner's `fy` points at. `fy` is said only by a machine that named none (an older one).
 */
export function passkeyWindowCommand(device: {
  readonly name?: string;
  readonly id: string;
  readonly clientName?: string;
}): string {
  const name = device.name?.trim();
  const printable =
    name !== undefined && name !== '' && !name.startsWith('-') && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name);
  const who = printable ? `'${name.replaceAll("'", "'\\''")}'` : device.id;
  const client = device.clientName !== undefined && SAFE_CLIENT_NAME.test(device.clientName) ? device.clientName : 'fy';
  return `${client} passkey window ${who}`;
}

/** Why no passkey can be added right now, per the registration rule; `command` is the exact line for the owner when known. */
export const registrationClosedSentence = (
  hasPasskeys: boolean,
  command: string = PASSKEY_WINDOW_PLACEHOLDER,
): string =>
  hasPasskeys
    ? `This device cannot add another passkey right now: ask the owner to run \`${command}\` at the machine.`
    : `A first passkey can be added only within 10 minutes of pairing: add one from a device that already has access, or ask the owner to run \`${command}\` at the machine.`;

/** The plain sentence a device with no passkey and no open window is told, with the command shown beside it. */
export const NO_WINDOW_SENTENCE = 'No window is open to add one. On the machine itself, run this:';

/** What to do once the owner has run it. */
export const AFTER_WINDOW_SENTENCE =
  'Then press Add a passkey. The window stays open for 10 minutes and takes one passkey.';

/** The failure line for a press that met a closed window while the command is on screen. */
export const stillClosedSentence = (command: string): string =>
  `No passkey window is open for this device yet. Run \`${command}\` on the machine, then try again.`;

/** When an open registration window closes, in one sentence, or `null` when the machine named no end. */
export function registrationClosesSentence(closesAt: string | undefined): string | null {
  if (closesAt === undefined) return null;
  const closes = new Date(closesAt);
  if (Number.isNaN(closes.getTime())) return null;
  return `You can add a passkey until ${closes.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`;
}

/**
 * How long an open registration window has left, as a short phrase ("7 minutes left"), or `null` when the machine named
 * no end, the end is not a time, or it has passed. Rounded UP: a window with 61 s left says 2 minutes, never a
 * false "closed", and under a minute says so.
 */
export function registrationMinutesLeft(closesAt: string | undefined, nowMs: number): string | null {
  if (closesAt === undefined) return null;
  const closes = new Date(closesAt).getTime();
  if (Number.isNaN(closes) || closes <= nowMs) return null;
  const minutes = Math.ceil((closes - nowMs) / 60_000);
  if (minutes <= 1) return 'less than a minute left';
  return `${minutes} minutes left`;
}

const REFUSAL_SENTENCES: Readonly<Record<StepUpRefusal, (origin: string) => string>> = {
  'not-a-device': () => 'Only a paired device can hold a passkey, and this browser is not paired to that machine.',
  'origin-not-allowed': origin =>
    `This machine serves only the hosted copy of the app, at ${HOSTED_APP_ORIGIN}, and this one is at ${origin}. Open Ferretry at ${HOSTED_APP_ORIGIN}.`,
  'registration-closed': () => registrationClosedSentence(false),
  'too-many-passkeys': () => 'This device already holds as many passkeys as this machine allows.',
  'no-passkey': origin => passkeySentence('no-passkey', origin),
  'not-verified': () => 'That passkey did not check out. Try again.',
  'rotation-required': () =>
    'This device needs a new key before it can confirm, and it makes one with the next confirmation. Try again.',
  'not-at-machine': () => 'Only the owner at the machine can open a passkey window, and this browser is not that.',
  'unknown-device': () => 'This machine does not know this device, so no passkey window can be opened for it.',
};

/** The one plain sentence for a failed registration or read — never a status code or a raw error name. */
export function passkeyFailureSentence(reason: unknown, origin: string): string {
  if (reason instanceof PasskeyCeremonyError) return passkeySentence(reason.kind, origin);
  if (reason instanceof FyHttpError) {
    for (const refusal of Object.keys(REFUSAL_SENTENCES) as StepUpRefusal[])
      if (reason.code === stepUpRefusalCode(refusal)) return REFUSAL_SENTENCES[refusal](origin);
  }
  return 'The passkey was not added. Try again.';
}

/** A readable name for a passkey, from the two facts the machine reports about it. */
export function passkeyLabel(passkey: { readonly origin: string; readonly createdAt: string }): string {
  const created = new Date(passkey.createdAt);
  const added = Number.isNaN(created.getTime())
    ? 'an unknown date'
    : created.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `Passkey for ${passkey.origin}, added ${added}`;
}

/** The slice of `localStorage` the nudge uses. */
export interface NudgeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const NUDGE_KEY_PREFIX = 'fy-passkey-nudge-dismissed-v1:';
const DISMISSED = '1';

/** `localStorage`, or nothing: reading the property itself throws in some private modes. */
export function browserNudgeStorage(): NudgeStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** Whether this machine's nudge was dismissed. Storage that throws or is absent reads as "not dismissed". */
export function passkeyNudgeDismissed(storage: NudgeStorage | undefined, daemonId: string): boolean {
  try {
    return storage?.getItem(`${NUDGE_KEY_PREFIX}${daemonId}`) === DISMISSED;
  } catch {
    return false;
  }
}

/** Remembers a dismissal for one machine. A refusing store is an ordinary browser condition. */
export function dismissPasskeyNudge(storage: NudgeStorage | undefined, daemonId: string): void {
  try {
    storage?.setItem(`${NUDGE_KEY_PREFIX}${daemonId}`, DISMISSED);
  } catch {
    // Private browsing: the line stays dismissed for this load and may return on the next.
  }
}
