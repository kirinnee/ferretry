/**
 * What the owner's Share sheet and Members list say and decide, as pure functions over what the daemon
 * answered (docs/design/catalogs.md §5.2 and §5.5).
 *
 * Plain words, short lines, one idea each. The daemon decides who may join and what a revoke ends; this
 * module only says it, and refuses a request the daemon would refuse before it is sent.
 *
 * NOTHING HERE HOLDS A CODE OR A LINK. They are in the answer to the mint, in the sheet's own state, and
 * nowhere else.
 */

import {
  CATALOG_SHARE_EXPIRIES,
  CATALOG_SHARE_EXPIRY_SECONDS,
  CATALOG_SHARE_MULTI_CAP_DEFAULT,
  CATALOG_SHARE_MULTI_CAP_MAX,
  type CatalogMemberKeyView,
  CatalogMemberLabelSchema,
  type CatalogMemberView,
  type CatalogShareExpiry,
  type CatalogShareMintRequest,
  type CatalogShareState,
  type CatalogShareUses,
  type CatalogShareView,
  type OwnedCatalog,
} from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import { shortAgo } from '../../lib/agenda-revisions.ts';
import { plural } from './catalog-review-model.ts';
import { type OwnerRefusal, ownerRefusal } from './catalogs-model.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const SHARE_NEW_PERSON_LABEL = 'A new person';
export const SHARE_EXISTING_PERSON_LABEL = 'Someone already in';
export const SHARE_NO_ONE_YET = 'No one has joined yet, so there is no one to pick.';
export const SHARE_MANY_NEEDS_NEW = 'A code for many people makes its own group. Name the group instead.';
export const SHARE_ONE_LABEL = 'One person. The code burns when it is used.';
export const SHARE_MANY_LABEL = 'Many people, until it expires.';
export const SHARE_CAP_LABEL = 'Most people who may join';
export const SHARE_CONFIRM_LABEL = 'Confirm with passkey';
export const SHARE_WAITING_LABEL = 'Waiting for your passkey…';
export const SHARE_CLOSE_NOTE = 'Close this and the link is gone for good. You can end the code under Shares.';
export const SHARE_EXPIRED_LINE = 'This code has expired. Make a new one to share again.';
export const SHARE_ENDED_LINE = 'This code is ended. Nobody can join with it now.';
export const SHARE_COPIED_LINE = 'Copied. Paste it where only they will read it.';
export const SHARE_COPY_FAILED_LINE = 'This browser would not copy it. Select the link and copy it by hand.';
export const SHARE_QR_LABEL = 'Share link QR code';
export const SHARE_QR_FAILED_LINE =
  'This link is too long for a QR code, so there is none to show. Use the link below.';

export const MEMBERS_EMPTY = 'No one has joined yet. Share a catalog to invite someone.';
export const SHARES_EMPTY = 'No codes yet.';
export const MEMBERS_TITLE = 'People and codes';
export const MEMBERS_NOTE =
  'A person can read the catalogs you give them, and nothing else on this machine. They never see each other.';

// ── Expiry and how many ──────────────────────────────────────────────────────────────────────────

const EXPIRY_WORDS: Readonly<Record<CatalogShareExpiry, string>> = {
  '15m': '15 minutes',
  '1h': '1 hour',
  '3h': '3 hours',
  '8h': '8 hours',
  '1d': '1 day',
};

export interface ExpiryChoice {
  readonly value: CatalogShareExpiry;
  readonly label: string;
}

/** How long the code works, shortest first. The sharer picks one; nothing longer exists. */
export const EXPIRY_CHOICES: readonly ExpiryChoice[] = CATALOG_SHARE_EXPIRIES.map(value => ({
  value,
  label: EXPIRY_WORDS[value],
}));

export const DEFAULT_EXPIRY: CatalogShareExpiry = '15m';

/** The cap a multi-use code starts with, as the text field holds it. */
export const DEFAULT_CAP_TEXT = String(CATALOG_SHARE_MULTI_CAP_DEFAULT);

export const CAP_PROBLEM = `Pick a whole number from 2 to ${String(CATALOG_SHARE_MULTI_CAP_MAX)}.`;

/** A cap typed by hand, or `null` when it is not a whole number in range. */
export function capFromText(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}$/u.test(trimmed)) return null;
  const cap = Number(trimmed);
  return cap >= 2 && cap <= CATALOG_SHARE_MULTI_CAP_MAX ? cap : null;
}

/** "single use" or "up to 50 people". */
export function usesNote(uses: CatalogShareUses): string {
  return uses.kind === 'single' ? 'single use' : `up to ${String(uses.cap)} people`;
}

// ── The draft ────────────────────────────────────────────────────────────────────────────────────

type ShareWho =
  | { readonly kind: 'new'; readonly name: string }
  | { readonly kind: 'existing'; readonly memberId: string };

type ShareHowMany = { readonly kind: 'single' } | { readonly kind: 'multi'; readonly cap: string };

/** Everything the form holds before the passkey: nothing here is secret. */
export interface ShareDraft {
  readonly who: ShareWho;
  readonly expiresIn: CatalogShareExpiry;
  readonly howMany: ShareHowMany;
}

export const emptyDraft = (): ShareDraft => ({
  who: { kind: 'new', name: '' },
  expiresIn: DEFAULT_EXPIRY,
  howMany: { kind: 'single' },
});

const memberById = (members: readonly CatalogMemberView[], memberId: string): CatalogMemberView | undefined =>
  members.find(member => member.memberId === memberId);

/** What a code for a person who can already read things lets its opener do. Said BEFORE anything is made. */
export function existingMemberWarning(label: string): string {
  return `Whoever opens this link can read everything ${label} can read, not only this catalog.`;
}

export const EXISTING_MEMBER_ADVICE = 'If you are not sure, make a new person instead.';

/** The name the link is for, as the result sheet says it. */
export function recipientName(draft: ShareDraft, members: readonly CatalogMemberView[]): string {
  if (draft.who.kind === 'new') return draft.who.name.trim();
  return memberById(members, draft.who.memberId)?.label ?? 'this person';
}

/** Why this form cannot go on, in words, or `null` when it can. */
export function shareProblem(draft: ShareDraft, members: readonly CatalogMemberView[]): string | null {
  if (draft.who.kind === 'new') {
    const name = draft.who.name.trim();
    if (name === '') return 'Type the name of the person this is for.';
    if (!CatalogMemberLabelSchema.safeParse(name).success)
      return 'Use a shorter name with no line breaks or hidden characters.';
    if (members.some(member => member.label.toLowerCase() === name.toLowerCase()))
      return `You already have someone called ${name}. Pick them under “${SHARE_EXISTING_PERSON_LABEL}”, or use another name.`;
  } else if (memberById(members, draft.who.memberId) === undefined) {
    return 'That person is gone. Pick someone else.';
  }
  if (draft.howMany.kind === 'multi') {
    if (draft.who.kind === 'existing') return SHARE_MANY_NEEDS_NEW;
    if (capFromText(draft.howMany.cap) === null) return CAP_PROBLEM;
  }
  return null;
}

/** The request for one catalog. Call it only when {@link shareProblem} is `null`. */
export function mintRequest(catalogId: string, draft: ShareDraft): CatalogShareMintRequest {
  const member =
    draft.who.kind === 'new'
      ? ({ kind: 'new', label: draft.who.name.trim() } as const)
      : ({ kind: 'existing', memberId: draft.who.memberId } as const);
  const uses =
    draft.howMany.kind === 'single'
      ? ({ kind: 'single' } as const)
      : ({ kind: 'multi', cap: capFromText(draft.howMany.cap) ?? CATALOG_SHARE_MULTI_CAP_DEFAULT } as const);
  return { catalogIds: [catalogId], member, expiresIn: draft.expiresIn, uses } as CatalogShareMintRequest;
}

// ── The shown-once result ────────────────────────────────────────────────────────────────────────

export const shareSheetTitle = (catalogName: string): string => `Share “${catalogName}”`;

export const shareResultTitle = (name: string): string => `Share link for ${name}`;

export const shownOnceLine = (name: string): string => `This is shown once. Send it to ${name} only.`;

export interface ShareCountdown {
  readonly expired: boolean;
  readonly secondsLeft: number;
  /** `14:52`, or `2:59:10` once there is an hour or more. */
  readonly clock: string;
}

const two = (value: number): string => String(value).padStart(2, '0');

/** Seconds left on a code. An unreadable instant counts as over: a dead code gets no confident clock. */
export function shareCountdown(expiresAt: string, nowMs: number): ShareCountdown {
  const endsMs = Date.parse(expiresAt);
  if (Number.isNaN(endsMs)) return { expired: true, secondsLeft: 0, clock: '0:00' };
  const secondsLeft = Math.max(0, Math.floor((endsMs - nowMs) / 1_000));
  const hours = Math.floor(secondsLeft / 3_600);
  const minutes = Math.floor((secondsLeft % 3_600) / 60);
  const seconds = secondsLeft % 60;
  return {
    expired: secondsLeft === 0,
    secondsLeft,
    clock: hours > 0 ? `${String(hours)}:${two(minutes)}:${two(seconds)}` : `${String(minutes)}:${two(seconds)}`,
  };
}

/** "Expires in 14:52 · single use", or the sentence for a code that ran out. */
export function expiryLine(countdown: ShareCountdown, uses: CatalogShareUses): string {
  return countdown.expired ? SHARE_EXPIRED_LINE : `Expires in ${countdown.clock} · ${usesNote(uses)}`;
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────

/** "Oct 31", or "Oct 31, 09:12" with the time. `timeZone` is for a test; the app shows the person's own. */
export function formatWhen(instant: string, options: { time?: boolean; timeZone?: string } = {}): string {
  const at = new Date(instant);
  if (Number.isNaN(at.getTime())) return 'an unknown time';
  return at.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(options.time === true ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' as const } : {}),
    ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
  });
}

// ── Shares ───────────────────────────────────────────────────────────────────────────────────────

/** A live share whose time has passed reads as expired: the list is a snapshot, the clock is not. */
export function effectiveShareState(share: CatalogShareView, nowMs: number): CatalogShareState {
  return share.state === 'live' && Date.parse(share.expiresAt) <= nowMs ? 'expired' : share.state;
}

const SHARE_STATE_WORDS: Readonly<Record<CatalogShareState, string>> = {
  live: 'live',
  spent: 'spent',
  expired: 'expired',
  ended: 'ended by you',
};

/** How long the code was made to work, or `null` when its window is not one of the five choices. */
export function shareLength(share: CatalogShareView): string | null {
  const seconds = Math.round((Date.parse(share.expiresAt) - Date.parse(share.createdAt)) / 1_000);
  const match = CATALOG_SHARE_EXPIRIES.find(choice => CATALOG_SHARE_EXPIRY_SECONDS[choice] === seconds);
  return match === undefined ? null : EXPIRY_WORDS[match];
}

export interface ShareRow {
  readonly shareId: string;
  readonly state: CatalogShareState;
  /** "for Bob · 1 day · unused · ends Nov 1, 09:12" */
  readonly line: string;
  /** Who used it, newest last: `“Firefox on a Mac” Oct 31`. */
  readonly usedBy: readonly string[];
  readonly canEnd: boolean;
}

/** One share, in words. It has no code to show: the daemon keeps only a hash. */
export function shareRow(share: CatalogShareView, nowMs: number, timeZone?: string): ShareRow {
  const state = effectiveShareState(share, nowMs);
  const when = (instant: string): string => formatWhen(instant, { time: true, ...(timeZone ? { timeZone } : {}) });
  const used = share.usedBy.length;
  const length = shareLength(share);
  const status =
    state === 'live'
      ? share.uses.kind === 'single'
        ? 'unused'
        : `${String(used)} of ${String(share.uses.cap)} used`
      : SHARE_STATE_WORDS[state];
  const parts = [
    `for ${share.memberLabel}`,
    ...(length === null ? [] : [length]),
    status,
    ...(state === 'live' ? [`ends ${when(share.expiresAt)}`] : []),
  ];
  return {
    shareId: share.shareId,
    state,
    line: parts.join(' · '),
    usedBy: share.usedBy.map(use => `“${use.clientName}” ${formatWhen(use.at, { ...(timeZone ? { timeZone } : {}) })}`),
    canEnd: state === 'live',
  };
}

/** Live codes first, soonest to end first; then the rest, newest first. */
export function orderedShares(shares: readonly CatalogShareView[], nowMs: number): readonly CatalogShareView[] {
  const live = (share: CatalogShareView): boolean => effectiveShareState(share, nowMs) === 'live';
  return [...shares].sort((a, b) => {
    if (live(a) !== live(b)) return live(a) ? -1 : 1;
    return live(a)
      ? Date.parse(a.expiresAt) - Date.parse(b.expiresAt)
      : Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

// ── Members ──────────────────────────────────────────────────────────────────────────────────────

/** The catalogs of this person that are on this machine, so the Take away menu lists only real ones. */
export function takeAwayChoices(member: CatalogMemberView, catalogs: readonly OwnedCatalog[]): readonly OwnedCatalog[] {
  return catalogs.filter(catalog => member.catalogIds.includes(catalog.id));
}

/** "joined Oct 31 · seen 2h ago · 1 passkey" */
export function browserLine(key: CatalogMemberKeyView, nowMs: number, timeZone?: string): string {
  const passkeys = key.passkeys === 0 ? 'no passkey yet' : plural(key.passkeys, 'passkey');
  const seen = key.lastSeenAt === undefined ? 'not seen yet' : `seen ${shortAgo(key.lastSeenAt, nowMs)}`;
  return `joined ${formatWhen(key.joinedAt, timeZone === undefined ? {} : { timeZone })} · ${seen} · ${passkeys}`;
}

/** The code that made this person, when it was a code for many people. */
export function multiShareOf(member: CatalogMemberView, shares: readonly CatalogShareView[]): CatalogShareView | null {
  const found = shares
    .filter(share => share.memberId === member.memberId && share.uses.kind === 'multi')
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return found[0] ?? null;
}

/** "multi-use code, 23 of 50 used, ends Oct 31, 16:00" */
export function multiSummary(share: CatalogShareView, nowMs: number, timeZone?: string): string {
  const cap = share.uses.kind === 'multi' ? share.uses.cap : share.usedBy.length;
  const live = effectiveShareState(share, nowMs) === 'live';
  const when = formatWhen(share.expiresAt, { time: true, ...(timeZone ? { timeZone } : {}) });
  return `multi-use code, ${String(share.usedBy.length)} of ${String(cap)} used, ${live ? 'ends' : 'ended'} ${when}`;
}

/** How many codes made for this person still work. */
export function liveShareCount(member: CatalogMemberView, shares: readonly CatalogShareView[], nowMs: number): number {
  return shares.filter(share => share.memberId === member.memberId && effectiveShareState(share, nowMs) === 'live')
    .length;
}

export const revokeLabel = (member: CatalogMemberView, multi: boolean): string =>
  multi && member.keys.length > 1 ? `Revoke all ${String(member.keys.length)}…` : `Revoke ${member.label}…`;

export interface ConfirmWords {
  readonly title: string;
  readonly lines: readonly string[];
  readonly yes: string;
}

/** §5.5: what a revoke does, said before it is done. */
export function revokeConfirm(member: CatalogMemberView, liveShares: number): ConfirmWords {
  const browsers = member.keys.length;
  const stops =
    browsers === 0
      ? `${member.label} has no browsers yet.`
      : browsers === 1
        ? `${member.label}’s 1 browser stops working now, and its open sessions close.`
        : `${member.label}’s ${String(browsers)} browsers stop working now, and their open sessions close.`;
  return {
    title: `Revoke ${member.label}?`,
    lines: [
      stops,
      ...(liveShares === 0
        ? []
        : [`${plural(liveShares, 'code')} made for ${member.label} ${liveShares === 1 ? 'ends' : 'end'} too.`]),
      `What ${member.label} already downloaded or installed stays with them.`,
    ],
    yes: 'Revoke',
  };
}

export function removeBrowserConfirm(member: CatalogMemberView, key: CatalogMemberKeyView): ConfirmWords {
  return {
    title: `Remove ${key.clientName}?`,
    lines: [
      'Only this browser stops working, and its open sessions close.',
      member.keys.length <= 1
        ? `It is the only browser ${member.label} has, so ${member.label} reads nothing until they join again with a new code.`
        : `${member.label}’s other browsers keep working.`,
    ],
    yes: 'Remove this browser',
  };
}

export function takeAwayConfirm(member: CatalogMemberView, catalogName: string): ConfirmWords {
  return {
    title: `Take ${catalogName} away from ${member.label}?`,
    lines: [`${member.label} stops seeing it now.`, 'What they already installed stays with them.'],
    yes: 'Take it away',
  };
}

export const shareEndedNote = (label: string): string => `The code for ${label} is ended.`;

export const browserRemovedNote = (label: string, clientName: string): string =>
  `${clientName} is removed. ${label}’s other browsers keep working.`;

export const catalogTakenNote = (label: string, catalogName: string): string =>
  `${label} can no longer read ${catalogName}.`;

export function revokedNote(label: string, keysRemoved: number, sharesEnded: number): string {
  const ended = sharesEnded === 0 ? '' : ` and ${plural(sharesEnded, 'code')} ended`;
  return `${label} is revoked. ${plural(keysRemoved, 'browser')} removed${ended}.`;
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

const SHARING_REFUSALS: Readonly<Record<string, string>> = {
  share_unknown: 'That code is gone. Look at the list again.',
  member_unknown: 'That person is gone. Look at the list again.',
  member_key_unknown: 'That browser is already gone. Look at the list again.',
  catalog_unknown: 'That catalog is gone. Close this and look at the list again.',
  members_full: 'This machine already holds as many people as it can. Revoke someone first, then try again.',
  shares_full: 'There are too many live codes. End one under Shares, then try again.',
  catalogs_full: 'A code can grant only so many catalogs. Share fewer at once.',
  share_link_unavailable:
    'No other person can reach this machine: it has no public address and is not on a relay their browser can find. No code was made. Nothing was spent. Turn the hosted relay on, or set a public address (publicUrl), then try again.',
  store_damaged: 'This machine could not read its sharing files. Nothing was changed. Check the machine’s log.',
};

/** A refusal from the sharing routes, as one sentence with the next step. Anything else is the catalogs’ own wording. */
export function sharingRefusal(error: unknown): OwnerRefusal {
  const code = error instanceof FyHttpError ? error.code : undefined;
  const known = code === undefined ? undefined : SHARING_REFUSALS[code];
  return known === undefined ? ownerRefusal(error) : { sentence: known, previewAgain: false, sharingOff: false };
}
