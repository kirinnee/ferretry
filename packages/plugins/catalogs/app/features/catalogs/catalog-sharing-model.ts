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
  CatalogMemberNameSchema,
  type CatalogMemberView,
  type CatalogShareExpiry,
  type CatalogShareMintRequest,
  type CatalogShareState,
  type CatalogShareUses,
  type CatalogShareView,
  MEMBER_NAME_HIDDEN_MESSAGE,
  MEMBER_NAME_MIXED_SCRIPT_MESSAGE,
  MEMBER_NAME_UNDRAWABLE_MESSAGE,
  memberNameKey,
  type OwnedCatalog,
} from '../../../contract/wire/index.ts';
import { DaemonCallError } from '@ferretry/app';
import { shortAgo } from '../../shell.ts';
import { plural } from './catalog-review-model.ts';
import { type OwnerRefusal, ownerRefusal } from './catalogs-model.ts';

// ── Words ────────────────────────────────────────────────────────────────────────────────────────

export const SHARE_USER_ID_LABEL = 'Their user ID';
export const SHARE_USER_ID_HELP =
  "Unique on this machine. They'll create a passkey under it and sign in with it. The same ID always means the same person.";
export const SHARE_USER_ID_PLACEHOLDER = 'e.g. alice';
export const SHARE_USER_ID_EMPTY = 'Type their user ID.';
export const SHARE_USER_ID_TOO_LONG = 'A user ID is at most 80 characters. Use a shorter one.';
export const SHARE_NEW_PASSKEY_LABEL = 'They need a new passkey (lost or new device)';
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

type ShareHowMany = { readonly kind: 'single' } | { readonly kind: 'multi'; readonly cap: string };

/** Everything the form holds before the passkey: nothing here is secret. */
export interface ShareDraft {
  /** The user ID as typed, spaces and all: the screen keeps the spelling the owner chose. */
  readonly userId: string;
  /** The owner's own tick of "They need a new passkey", or `null` while they have not touched it. */
  readonly newPasskey: boolean | null;
  readonly expiresIn: CatalogShareExpiry;
  readonly howMany: ShareHowMany;
}

export const emptyDraft = (): ShareDraft => ({
  userId: '',
  newPasskey: null,
  expiresIn: DEFAULT_EXPIRY,
  howMany: { kind: 'single' },
});

/** The person a typed user ID already is, compared the way the machine compares: look-alikes and case do not count. */
export function personWithId(userId: string, members: readonly CatalogMemberView[]): CatalogMemberView | undefined {
  const typed = userId.trim();
  if (typed === '') return undefined;
  const key = memberNameKey(typed);
  return members.find(member => memberNameKey(member.label) === key);
}

/** Up to five people whose user ID holds what was typed, those that start with it first; none for an exact match. */
export function suggestPeople(userId: string, members: readonly CatalogMemberView[]): readonly CatalogMemberView[] {
  const typed = userId.trim();
  if (typed === '' || personWithId(typed, members) !== undefined) return [];
  const key = memberNameKey(typed);
  const holders = members.filter(member => memberNameKey(member.label).includes(key));
  const starts = (member: CatalogMemberView): number => (memberNameKey(member.label).startsWith(key) ? 0 : 1);
  return [...holders].sort((a, b) => starts(a) - starts(b)).slice(0, 5);
}

/** The person has no passkey on any browser, so nobody can prove one for them: the machine's own rule, mirrored. */
export const hasNoPasskeyLeft = (member: CatalogMemberView): boolean => !member.keys.some(key => key.passkeys > 0);

export interface NewPasskeyChoice {
  /** Whether the checkbox is on screen: an existing person, on an invite for one browser. */
  readonly offered: boolean;
  readonly ticked: boolean;
  /** Ticked for the owner because the person has no passkey left (still theirs to untick). */
  readonly preTicked: boolean;
}

/** D8. Never automatic on the wire: the owner's draft decides, and a pre-tick is only a starting point on screen. */
export function newPasskeyChoice(draft: ShareDraft, members: readonly CatalogMemberView[]): NewPasskeyChoice {
  const person = personWithId(draft.userId, members);
  const offered = person !== undefined && draft.howMany.kind === 'single';
  if (!offered) return { offered: false, ticked: false, preTicked: false };
  const lost = hasNoPasskeyLeft(person);
  return { offered, ticked: draft.newPasskey ?? lost, preTicked: lost && draft.newPasskey === null };
}

export const newPasskeyHelp = (id: string): string =>
  `Only tick this if ${id} can't use their passkey any more. Whoever opens this invite can then sign in as ${id}.`;

export const newPasskeyPreTicked = (id: string): string =>
  `${id} has no passkey left, so this invite lets them create one.`;

/** The line under the field. `id` is the part the screen shows in bold. */
export interface UserIdLine {
  readonly kind: 'existing' | 'new';
  readonly id: string;
  readonly before: string;
  readonly after: string;
}

/** "2 browsers · Team skills": what an existing person already has here. */
export function whatTheyHave(member: CatalogMemberView, catalogs: readonly OwnedCatalog[]): string {
  const browsers = member.keys.length === 0 ? 'no browsers yet' : plural(member.keys.length, 'browser');
  const named = member.catalogIds.map(id => catalogs.find(catalog => catalog.id === id)?.name);
  const catalogsLine = named.every(name => name !== undefined)
    ? named.join(', ')
    : plural(member.catalogIds.length, 'catalog');
  return member.catalogIds.length === 0 ? browsers : `${browsers} · ${catalogsLine}`;
}

/** What typing this user ID means, said before anything is made; `null` while nothing valid is typed. */
export function userIdLine(
  draft: ShareDraft,
  members: readonly CatalogMemberView[],
  catalogs: readonly OwnedCatalog[],
): UserIdLine | null {
  if (draft.userId.trim() === '' || userIdProblem(draft.userId) !== null) return null;
  const person = personWithId(draft.userId, members);
  if (person !== undefined)
    return {
      kind: 'existing',
      id: person.label,
      before: '',
      after: ` already has access here (${whatTheyHave(person, catalogs)}). This invite reaches the same person: they sign in with their ${person.label} passkey.`,
    };
  return {
    kind: 'new',
    id: draft.userId.trim(),
    before: 'New user ID. The person who opens this invite creates a passkey for ',
    after: '.',
  };
}

/** The user ID as the invite names it: the matched person's own spelling, else what was typed. */
export function recipientName(draft: ShareDraft, members: readonly CatalogMemberView[]): string {
  return personWithId(draft.userId, members)?.label ?? draft.userId.trim();
}

const USER_ID_RULES: readonly string[] = [
  MEMBER_NAME_HIDDEN_MESSAGE,
  MEMBER_NAME_UNDRAWABLE_MESSAGE,
  MEMBER_NAME_MIXED_SCRIPT_MESSAGE,
];

/** Why this text cannot be a user ID, in the machine's own words, or `null`. The text itself is never echoed. */
export function userIdProblem(userId: string): string | null {
  const typed = userId.trim();
  if (typed === '') return null;
  const chosen = CatalogMemberNameSchema.safeParse(typed);
  if (chosen.success) return null;
  return chosen.error.issues.find(issue => USER_ID_RULES.includes(issue.message))?.message ?? SHARE_USER_ID_TOO_LONG;
}

/** Why this form cannot go on, in words, or `null` when it can. */
export function shareProblem(draft: ShareDraft): string | null {
  if (draft.userId.trim() === '') return SHARE_USER_ID_EMPTY;
  const rule = userIdProblem(draft.userId);
  if (rule !== null) return rule;
  if (draft.howMany.kind === 'multi' && capFromText(draft.howMany.cap) === null) return CAP_PROBLEM;
  return null;
}

/** The request for one catalog. Call it only when {@link shareProblem} is `null`. */
export function mintRequest(
  catalogId: string,
  draft: ShareDraft,
  members: readonly CatalogMemberView[],
): CatalogShareMintRequest {
  const uses =
    draft.howMany.kind === 'single'
      ? ({ kind: 'single' } as const)
      : ({ kind: 'multi', cap: capFromText(draft.howMany.cap) ?? CATALOG_SHARE_MULTI_CAP_DEFAULT } as const);
  return {
    catalogIds: [catalogId],
    member: { name: draft.userId.trim() },
    expiresIn: draft.expiresIn,
    uses,
    ...(newPasskeyChoice(draft, members).ticked ? { newPasskey: true } : {}),
  };
}

// ── The shown-once result ────────────────────────────────────────────────────────────────────────

export const shareSheetTitle = (catalogName: string): string => `Invite people to “${catalogName}”`;

export const shareResultTitle = (name: string): string => `Invite for ${name}`;

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
    ...(share.newPasskey === true && state === 'live' ? ['new passkey'] : []),
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

export const CHANGE_USER_ID_LABEL = 'Change user ID';
export const CHANGE_USER_ID_INPUT_LABEL = 'New user ID';
export const CHANGE_USER_ID_SAVE = 'Change user ID';
export const CHANGE_USER_ID_CANCEL = 'Keep it';

/** "since Oct 31 · 2 browsers · 1 passkey" */
export function personFacts(member: CatalogMemberView, timeZone?: string): string {
  const passkeys = member.keys.reduce((total, key) => total + key.passkeys, 0);
  const since = formatWhen(member.createdAt, timeZone === undefined ? {} : { timeZone });
  return `since ${since} · ${plural(member.keys.length, 'browser')} · ${plural(passkeys, 'passkey')}`;
}

/** What a rename does, said before it is done. `to` is the new user ID as typed. */
export const changeUserIdSentence = (from: string, to: string): string =>
  `${from} becomes ${to}. They keep their browsers, passkeys and installs.`;

export const userIdChangedNote = (from: string, to: string): string => `${from} is now ${to}.`;

/** Why a new user ID cannot be saved yet, or `null`. It is the owner's own typing, never echoed when invalid. */
export function changeUserIdProblem(
  typed: string,
  member: CatalogMemberView,
  members: readonly CatalogMemberView[],
): string | null {
  const text = typed.trim();
  if (text === '') return SHARE_USER_ID_EMPTY;
  const rule = userIdProblem(text);
  if (rule !== null) return rule;
  if (text === member.label) return 'That is already their user ID.';
  const holder = personWithId(text, members);
  return holder !== undefined && holder.memberId !== member.memberId ? takenUserIdLine(text) : null;
}

export const takenUserIdLine = (id: string): string => `Someone here already has the user ID ${id}. Pick another.`;

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
  const code = error instanceof DaemonCallError ? error.code : undefined;
  const known = code === undefined ? undefined : SHARING_REFUSALS[code];
  return known === undefined ? ownerRefusal(error) : { sentence: known, previewAgain: false, sharingOff: false };
}
