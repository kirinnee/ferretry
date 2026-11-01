/**
 * What a catalog MEMBER reads and is told: every sentence, the passkey countdown, and which failure is
 * which. Pure; no network, no clock of its own. A refusal is always a sentence with the next step.
 */

import { revealHidden, type SharedRedeemResponse } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { MemberRefusedError, MemberUnreachableError } from '../../lib/member-client.ts';
import { fingerprintHead, type MemberSubscription } from '../../lib/member-keys.ts';
import { PasskeyCeremonyError, passkeySentence } from '../../lib/passkeys.ts';

export const JOIN_REFUSED_SENTENCE = 'This link did not work: it may be used, expired or ended. Ask for a new one.';
export const NOT_A_SHARE_LINK = 'This is not a share link. Ask the person who sent it for a new one.';
export const REFUSED_TITLE = 'Access refused';
export const REFUSED_SENTENCE =
  'This machine refused this browser just now. It may have revoked access, or the connection may have been interrupted. Nothing was deleted here.';
export const STILL_REFUSED_SENTENCE = 'It refused again. If you were taken off, ask the owner for a new link.';
export const REFUSED_JOIN_AGAIN = 'Join with a new link';
export const REFUSED_JOIN_AGAIN_NOTE = 'Ask the owner for a new link, then open it here.';
export const FORGET_CATALOG = 'Forget this catalog';
export const FORGET_NOTE = 'This removes the key from this browser. You can join again later with a new link.';
export const LEAVE = 'Leave';
export const LEAVE_NOTE = 'You will stop seeing this publisher’s catalogs. What you installed stays.';
export const LEFT_SENTENCE = 'You left. You can join again later with a new link.';
export const UNLOCK_NOTE = 'Use your passkey to see what is shared with you.';
export const SHARED_WITH_ME = 'Shared with me';
export const NOTHING_SHARED = 'Nothing is shared with you yet. Open a share link to join.';
export const ONLINE_ONLY = 'You need to be online to see these.';
export const NOT_SHOWN_SENTENCE = 'This catalog was not shown: it was not signed by the publisher it names.';

/** Seconds left of a window, never below 0. */
export function secondsLeft(endsAt: string, now: Date): number {
  return Math.max(0, Math.ceil((Date.parse(endsAt) - now.getTime()) / 1000));
}

/** `m:ss` for a number of seconds. */
export function formatCountdown(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

export interface PasskeyWindow {
  readonly open: boolean;
  readonly seconds: number;
  /** Under a minute: the line gets louder, in words, not only in colour. */
  readonly urgent: boolean;
  readonly sentence: string;
}

export const WINDOW_CLOSED_SENTENCE =
  'The time to add a passkey ran out, so this link stopped working. Join again with a new link.';

/** The countdown line. Said BEFORE the window ends, and again, plainly, after. */
export function passkeyWindow(endsAt: string, now: Date): PasskeyWindow {
  const seconds = secondsLeft(endsAt, now);
  if (seconds === 0) return { open: false, seconds, urgent: false, sentence: WINDOW_CLOSED_SENTENCE };
  return {
    open: true,
    seconds,
    urgent: seconds <= 60,
    sentence: `Add a passkey in the next ${formatCountdown(seconds)} or this link stops working.`,
  };
}

export const passkeyHeading = (memberLabel: string, publisherLabel: string): string =>
  `Add a passkey for ${revealHidden(memberLabel)} on ${revealHidden(publisherLabel)}`;

export const PASSKEY_EXPLAIN = 'A passkey is how you unlock these catalogs next time.';
export const PASSKEY_BUTTON = 'Add a passkey';
export const UNLOCK_BUTTON = 'Unlock with passkey';

/** A publisher as the person sees it: their own label, and the part of the fingerprint to compare. */
export interface PublisherLine {
  readonly label: string;
  readonly publisherName: string;
  readonly fingerprint: string;
  readonly fingerprintFull: string;
  readonly refused: boolean;
}

export function publisherLine(subscription: MemberSubscription): PublisherLine {
  return {
    label: revealHidden(subscription.ownLabel),
    publisherName: revealHidden(subscription.daemonName),
    fingerprint: fingerprintHead(subscription.daemonId),
    fingerprintFull: subscription.daemonId,
    refused: subscription.status === 'refused',
  };
}

// ── Failures ────────────────────────────────────────────────────────────────────────────────────

export type ProblemKind = 'unreachable' | 'locked' | 'window-closed' | 'ceremony' | 'gone' | 'full' | 'other';

export interface Problem {
  readonly kind: ProblemKind;
  readonly sentence: string;
}

const CODE_SENTENCES: Readonly<Record<string, Problem>> = {
  member_locked: { kind: 'locked', sentence: 'Unlock with your passkey first.' },
  member_registration_closed: { kind: 'window-closed', sentence: WINDOW_CLOSED_SENTENCE },
  member_not_verified: {
    kind: 'ceremony',
    sentence: 'That passkey could not be checked. Try again with the same device.',
  },
  'too-many-passkeys': {
    kind: 'ceremony',
    sentence: 'This browser already has the most passkeys it can have here.',
  },
  'no-passkey': { kind: 'ceremony', sentence: 'There is no passkey to unlock with. Join again with a new link.' },
  catalog_unknown: { kind: 'gone', sentence: 'The publisher no longer shares this catalog with you.' },
  item_unknown: { kind: 'gone', sentence: 'The publisher no longer has this item.' },
  item_withdrawn: { kind: 'gone', sentence: 'The publisher took this item out. It cannot be opened.' },
  members_full: { kind: 'full', sentence: 'This publisher has no room for more people. Ask the owner.' },
};

/** The sentence and kind for anything a member call can throw (a refusal of the key is handled apart). */
export function problemFor(error: unknown, origin: string): Problem {
  if (error instanceof MemberUnreachableError)
    return { kind: 'unreachable', sentence: 'Could not reach the publisher. Check you are online, then try again.' };
  if (error instanceof PasskeyCeremonyError) return { kind: 'ceremony', sentence: passkeySentence(error.kind, origin) };
  if (error instanceof FyHttpError && error.code !== undefined) {
    const known = CODE_SENTENCES[error.code];
    if (known !== undefined) return known;
  }
  return { kind: 'other', sentence: 'That did not work. Try again in a moment.' };
}

export const isKeyRefused = (error: unknown): boolean => error instanceof MemberRefusedError;

// ── Opening a link with a key already here ──────────────────────────────────────────────────────

export const REDEEM_OTHER_MEMBER =
  'This link was made for someone else. It is now used up, and the owner has been told. Ask them for a link made for you.';
export const REDEEM_NEW_MEMBER =
  'This link was made for a new person, but this browser is already a member here. It is now used up. Ask for a link made for you.';

const REDEEM_SENTENCES: Readonly<Record<string, string>> = {
  share_refused: JOIN_REFUSED_SENTENCE,
  share_other_member: REDEEM_OTHER_MEMBER,
  share_new_member: REDEEM_NEW_MEMBER,
  members_full: 'This publisher has no room for more people. Ask the owner.',
  member_locked: 'Unlock with your passkey first, then open the link again.',
};

/** What a redeem that was refused says. Falls back to a plain retry for anything else. */
export function redeemRefusal(error: unknown, origin: string): string {
  if (error instanceof FyHttpError && error.code !== undefined) {
    const known = REDEEM_SENTENCES[error.code];
    if (known !== undefined) return known;
  }
  return problemFor(error, origin).sentence;
}

/** What a redeem that worked says. */
export function redeemedSentence(response: SharedRedeemResponse): string {
  const names = response.added.map(added => added.name);
  if (names.length === 0) return 'You already had everything in this link.';
  return names.length === 1 ? `Added ${names[0]}.` : `Added ${names.length} catalogs: ${names.join(', ')}.`;
}
