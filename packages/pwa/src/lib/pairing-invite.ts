/**
 * ADDING A DEVICE, as sentences and numbers rather than as components.
 *
 * The wording lives here for the reason the grant wording does: the Add-a-device panel, the countdown
 * beside the QR and the refusal a remote browser meets are three places that must not word the same
 * fact three ways. It is pure and total — every function takes the clock as an argument — so a test and
 * a screenshot see the same string, and nothing here can read a credential out of anywhere.
 *
 * WHAT IS DELIBERATELY ABSENT: the code. Nothing in this module stores, caches or logs a pairing code or
 * a pairing URL. The values travel as arguments to a formatter and are dropped; the only thing that
 * holds a live code is the component's own state, for as long as the modal is open.
 */

import type { PairedDevice, PairedDevicesView } from '@ferretry/protocol';

/**
 * What a reader is told about the two-minute window, once, beside the code.
 *
 * NOT A WARNING, A FACT AND ITS REMEDY. A code that expires while somebody walks to the other room is
 * the ordinary case rather than a failure, and the useful sentence says what to do about it — otherwise
 * a person stares at a dead QR wondering what they did wrong.
 */
export const PAIRING_EXPIRY_NOTE =
  'A code lasts two minutes and works once. When it runs out nothing is broken — ask for another one.';

/** The line beside a code that has already run out, so a stale screen never reads as a live one. */
export const PAIRING_EXPIRED_NOTE = 'This code has expired and can no longer add a device. Ask for another one.';

/** Who the code disclosure can truthfully tell somebody to hand it to. */
export type PairingOfferKind = 'qr' | 'local-only' | 'refusal';

/**
 * What the code actually gives away, said plainly next to it while it is on screen.
 *
 * WORDED TO WHAT THIS OFFER CAN ACTUALLY REACH. The first sentence — the fact being disclosed — never
 * changes, but "show it to the phone you are adding" is a lie beside a `local-only` or `refusal` offer:
 * there is no phone that link works for, and for a `refusal` there is no link at all. Saying so per
 * offer is the same fix `fy pair`'s headline already has (`render.ts:175-178`) applied to this line.
 */
export function pairingCodeDisclosure(offerKind: PairingOfferKind): string {
  const fact = 'Anyone who reads this code within its two minutes can add their device to this machine.';
  switch (offerKind) {
    case 'qr':
      return `${fact} Show it to the phone you are adding and nothing else.`;
    case 'local-only':
      return `${fact} Show it to a browser on this machine and nothing else.`;
    case 'refusal':
      return `${fact} There is no link to hand out, so keep it to yourself.`;
  }
}

/** How the QR is meant to be used, because the in-app scanner is not the intended path on most phones. */
export const PAIRING_SCAN_HINT =
  'Point the phone’s own camera app at this. It opens Ferretry with the code already filled in.';

/** Why the URL is spelled out under the QR, in a form somebody can retype. */
export const PAIRING_TYPE_HINT =
  'Cameras fail. This is the same link, selectable, so it can be typed or sent to the device another way.';

/** The countdown a screen shows, and whether the code is still worth showing at all. */
export interface PairingCountdown {
  readonly expired: boolean;
  /** Whole seconds left, floored, never negative. */
  readonly secondsLeft: number;
  /** `m:ss`, so it reads as a countdown rather than as a number of seconds. */
  readonly label: string;
}

/**
 * How long a minted code has left.
 *
 * FLOOR, NOT ROUND, and the difference matters at the end: rounding shows `0:00` for half a second while
 * the code still works, and a person who reads `0:00` stops trying. `expired` is decided from the same
 * value the label came from, so the two cannot disagree.
 *
 * An unparseable instant reads as EXPIRED. A daemon that answered with something this cannot read has
 * not given a window anybody may rely on, and treating unknown as "plenty of time" would leave a dead
 * code on screen with a confident countdown beside it.
 */
export function pairingCountdown(expiresAt: string, nowMs: number): PairingCountdown {
  const expiresAtMs = Date.parse(expiresAt);
  if (Number.isNaN(expiresAtMs)) return { expired: true, secondsLeft: 0, label: '0:00' };
  const secondsLeft = Math.max(0, Math.floor((expiresAtMs - nowMs) / 1_000));
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  return {
    expired: secondsLeft === 0,
    secondsLeft,
    label: `${String(minutes)}:${String(seconds).padStart(2, '0')}`,
  };
}

/**
 * How often the countdown re-renders.
 *
 * One second, matching what it displays. A faster tick would repaint a label that cannot have changed,
 * and a slower one would show a number that is already wrong.
 */
export const PAIRING_TICK_MS = 1_000;

/** One device row's supporting line: when it was added, and when this daemon last heard from it. */
export function pairedDeviceSummary(device: PairedDevice): string {
  const added = new Date(device.createdAt);
  const seen = new Date(device.lastSeenAt);
  const addedLabel = Number.isNaN(added.getTime()) ? 'an unknown time' : added.toLocaleString();
  if (Number.isNaN(seen.getTime()) || device.lastSeenAt === device.createdAt) return `Added ${addedLabel}`;
  return `Added ${addedLabel} · last seen ${seen.toLocaleString()}`;
}

/**
 * The devices, in a stable order a person can build a habit around.
 *
 * NEWEST FIRST, because the device somebody just added is the one they are looking for, and ties broken
 * by id so two grants created in the same millisecond do not swap places between renders. A daemon is
 * free to serve them in any order; a list that reshuffles is a list where somebody revokes the wrong row.
 */
export function orderedPairedDevices(view: PairedDevicesView): readonly PairedDevice[] {
  return [...view.devices].sort((left, right) => {
    const difference = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (Number.isFinite(difference) && difference !== 0) return difference;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

/** Whether this row is the credential the reader is holding right now. */
export function isThisDevice(device: PairedDevice, view: PairedDevicesView): boolean {
  return view.thisDeviceId !== undefined && view.thisDeviceId === device.id;
}

/**
 * What revoking this row will do, said BEFORE the press rather than discovered after it.
 *
 * Revoking the credential you are currently using is a legitimate act — signing this browser out of a
 * machine is exactly how somebody hands a laptop back — so it is offered rather than blocked. What is not
 * acceptable is being surprised by it, so the row says what will happen in the same breath as the button.
 */
export function revokeConsequence(device: PairedDevice, view: PairedDevicesView): string {
  return isThisDevice(device, view)
    ? 'This is the device you are using. Revoking it signs this browser out of this machine immediately.'
    : `Revoking removes ${device.name}’s access to this machine straight away. It can be added again with a new code.`;
}

/**
 * The one sentence that explains an Add-a-device panel a caller may not use.
 *
 * THE DAEMON'S OWN REASON IS PREFERRED, WHOLE. It already names the command a person runs, composed by
 * the layer that knows what this product's client is called, and replacing it with wording invented here
 * would either repeat it or contradict it. This adds only what the daemon cannot know: that the machine
 * itself is never governed by any of this, which is the fastest way out of the refusal.
 *
 * The fallback is used when a request failed for a reason that is not a refusal at all — a daemon that
 * could not be reached. It says so rather than implying a permission problem, because sending somebody
 * to hunt for a grant they already have is worse than saying "this did not answer".
 */
export function pairingRefusal(reason: string): string {
  const trimmed = reason.trim();
  const detail = trimmed === '' ? 'This daemon did not say why.' : trimmed;
  return `${detail} Pairing from the machine itself is never restricted, so a browser on that machine can always add a device.`;
}

/**
 * Whether a failure was the operator's decision or something else.
 *
 * The daemon distinguishes them by CODE — `grant_*` per reason — precisely so a UI does not have to read
 * prose to tell "you are not allowed" from "nothing answered". Getting this wrong in either direction is
 * a dead end: a network error dressed as a permission problem sends somebody to the wrong screen, and a
 * permission problem dressed as an outage sends them to reboot a daemon that is working.
 */
export function isGrantRefusal(code: string | undefined): boolean {
  return code?.startsWith('grant_') === true;
}
