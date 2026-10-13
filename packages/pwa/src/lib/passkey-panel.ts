/**
 * What the Security panel and the post-pairing nudge need that is not a component: browser support,
 * the sentence each refusal becomes, how a passkey is named, and the per-machine "not now" memory.
 *
 * A passkey has no name on the wire (`PasskeyView` is id, origin, created-at), so the label is derived
 * from those two facts and never invented.
 */

import { type StepUpRefusal, stepUpRefusalCode } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { PasskeyCeremonyError, passkeySentence } from './passkeys.ts';

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

/** Why no passkey can be added right now, per the registration rule. */
export const registrationClosedSentence = (hasPasskeys: boolean): string =>
  hasPasskeys
    ? 'Adding another passkey needs a recent passkey confirmation: make a change in Settings and confirm it, then come back here.'
    : 'A first passkey can be added only within 10 minutes of pairing: add one from a device that already has access, or pair this device again at the machine.';

const REFUSAL_SENTENCES: Readonly<Record<StepUpRefusal, (origin: string) => string>> = {
  'not-a-device': () => 'Only a paired device can hold a passkey, and this browser is not paired to that machine.',
  'origin-not-allowed': origin =>
    `This machine does not serve the copy of the app at ${origin}. Open Ferretry at an address the machine lists.`,
  'registration-closed': () => registrationClosedSentence(false),
  'too-many-passkeys': () => 'This device already holds as many passkeys as this machine allows.',
  'no-passkey': origin => passkeySentence('no-passkey', origin),
  'not-verified': () => 'That passkey did not check out. Try again.',
  'rotation-required': () =>
    'This device needs a new key before it can confirm, and it makes one with the next confirmation. Try again.',
  'not-at-machine': () => 'Only the owner at the machine can re-open a passkey window for a device.',
  'unknown-device': () => 'That machine has no paired device with that name. Pair it first.',
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
