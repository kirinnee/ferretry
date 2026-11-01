import {
  AGENDA_PUSH_BODY_LENGTH,
  AGENDA_PUSH_TITLE_LENGTH,
  type AgendaItem,
  type AgendaSnapshot,
  agendaBadgeCount,
  agendaNotificationPath,
  agendaTitle,
  clipAtWord,
  PHONE_APPROVAL_TITLE,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
} from '@ferretry/protocol';
import { DEVICE_PAIRED_TITLE } from '../audit/policy.ts';

export type SessionNotificationPayload = Extract<PushNotificationPayload, { readonly sessionId: string }>;

/**
 * The daemon-wide identity of one logical push. Exactly one of the three buzz reasons names it
 * (docs/notifications.md § When the phone buzzes); the `infoRequest` and `surfaced` forms are the retired
 * pushes of an earlier model, kept only so a ledger written under them still reads.
 */
export interface NotificationIdentity {
  readonly sessionId: string;
  /** The item the push opens: the notice, the item past its deadline, or the stop's first item. */
  readonly agendaId: string;
  /** A notice's own push: it asked the phone to buzz (`fy notify --ping`). */
  readonly ping?: boolean;
  /** The one push an item makes when its `neededBy` comes within the warning window. */
  readonly deadline?: boolean;
  /** The one push a stop makes, named by the instant the ferret's turn boundary was recorded. */
  readonly stoppedAt?: string;
  /** The one push a snoozed item makes when it wakes, named by the instant it woke. */
  readonly woke?: string;
  /**
   * An approve-on-phone card's push (docs/input-requests.md, "Approve on your phone"): 0 at the raise, then one more
   * for each new number the daemon read. One push per number, never a second for the same one.
   */
  readonly phoneApproval?: number;
  /** @deprecated retired; ledgers written before the buzz policy carry it. */
  readonly infoRequest?: number;
  /** @deprecated retired; ledgers written before the buzz policy carry it. */
  readonly surfaced?: boolean;
}

/** The key's spelling before the agenda rename; a ledger written then holds keys that begin with it. */
const LEGACY_KEY_PREFIX = 'attention:';
const KEY_PREFIX = 'agenda:';

/** A key in the spelling this daemon writes, whichever spelling it was read in. */
export function normalizedNotificationKey(key: string): string {
  return key.startsWith(LEGACY_KEY_PREFIX) ? `${KEY_PREFIX}${key.slice(LEGACY_KEY_PREFIX.length)}` : key;
}

/** The same key as an earlier daemon wrote it. */
export function legacyNotificationKey(key: string): string {
  return key.startsWith(KEY_PREFIX) ? `${LEGACY_KEY_PREFIX}${key.slice(KEY_PREFIX.length)}` : key;
}

export function notificationKey(identity: NotificationIdentity): string {
  // A stop is about the ferret, not about one of its items: the item that triggers it may change within
  // the stop, and the key must not.
  if (identity.stoppedAt !== undefined) return `${KEY_PREFIX}${identity.sessionId}:stopped:${identity.stoppedAt}`;
  const base = `${KEY_PREFIX}${identity.sessionId}:${identity.agendaId}`;
  if (identity.woke !== undefined) return `${base}:woke:${identity.woke}`;
  if (identity.phoneApproval !== undefined) return `${base}:phone-approval:${identity.phoneApproval}`;
  if (identity.ping === true) return `${base}:ping`;
  if (identity.deadline === true) return `${base}:deadline`;
  return `${base}${identity.infoRequest === undefined ? '' : `:info-${identity.infoRequest}`}${identity.surfaced === true ? ':surfaced' : ''}`;
}

/**
 * THE PUSH A NOTICE MAKES WHEN IT ASKED FOR ONE (`fy notify --ping`). A lock screen gets the notice's title
 * and its summary, nothing else; a tap opens the ferret's chat at the notice.
 */
export function pingNotificationPayload(
  sessionId: string,
  item: AgendaItem,
  snapshot: AgendaSnapshot,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `notice-ping:${item.id}`,
    sessionId,
    kind: 'attention',
    title: agendaNotificationTitle(agendaTitle(item)),
    body: clipAtWord(oneLine(item.subject), AGENDA_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: agendaNotificationPath(sessionId, item.id),
    count: agendaBadgeCount(snapshot),
  }) as SessionNotificationPayload;
}

/**
 * What the one push says when an item's `neededBy` has come within the warning window: the card's title,
 * and the time left (or that it passed) ahead of its ask.
 */
export function deadlineNotificationPayload(
  sessionId: string,
  item: AgendaItem,
  snapshot: AgendaSnapshot,
  now: string,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-deadline:${item.id}`,
    sessionId,
    kind: 'attention',
    title: agendaNotificationTitle(agendaTitle(item)),
    body: clipAtWord(`${timeLeftPhrase(item.neededBy, now)}: ${oneLine(item.subject)}`, AGENDA_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: agendaNotificationPath(sessionId, item.id),
    count: agendaBadgeCount(snapshot),
  }) as SessionNotificationPayload;
}

/** What a snoozed item says when it wakes and it blocks or has a deadline: "Back from snooze: <ask>". */
export function wokeNotificationPayload(
  sessionId: string,
  item: AgendaItem,
  snapshot: AgendaSnapshot,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-woke:${item.id}`,
    sessionId,
    kind: 'attention',
    title: agendaNotificationTitle(agendaTitle(item)),
    body: clipAtWord(`Back from snooze: ${oneLine(item.subject)}`, AGENDA_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: agendaNotificationPath(sessionId, item.id),
    count: agendaBadgeCount(snapshot),
  }) as SessionNotificationPayload;
}

/**
 * WHAT AN APPROVE-ON-PHONE PUSH SAYS: the daemon's own heading and the body `phoneApprovalWords` built from what the
 * daemon observed (the number first when it read one, owner decision !A171). Never through `agendaNotificationTitle`:
 * the heading is reserved for this push, and its tag is the approval's own, so a new number replaces the last one on
 * the lock screen instead of piling up.
 */
export function phoneApprovalNotificationPayload(
  sessionId: string,
  item: AgendaItem,
  approval: { readonly id: string; readonly body: string },
  snapshot: AgendaSnapshot,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `phone-approval:${approval.id}`,
    sessionId,
    kind: 'attention',
    title: PHONE_APPROVAL_TITLE,
    body: clipAtWord(oneLine(approval.body), AGENDA_PUSH_BODY_LENGTH),
    tag: phoneApprovalTag(approval.id),
    url: agendaNotificationPath(sessionId, item.id),
    count: agendaBadgeCount(snapshot),
  }) as SessionNotificationPayload;
}

/** The tag every push of one approval shares (`pa-<id>`): the service worker renotifies under it. */
export const phoneApprovalTag = (id: string): string => `pa-${id}`;

/** The item a stop's push shows and opens: the one blocking now, else the oldest waiting. */
export function stopShows(waiting: readonly [AgendaItem, ...AgendaItem[]]): AgendaItem {
  return waiting.find(item => item.blockingNow === true) ?? waiting[0];
}

/** The longest ferret name a stop's title carries whole; the count after it must survive a lock screen. */
const STOPPED_NAME_LENGTH = 24;

/**
 * What the ONE push a stop makes says: "<ferret> is stopped · 3 need you". The count is in the title, never
 * clipped away by a long ferret name; the body is the title of the item the owner most likely wants first
 * (the one blocking now, else the oldest), and a tap opens the ferret's chat at it.
 */
export function stoppedNotificationPayload(
  sessionId: string,
  ferret: string,
  waiting: readonly [AgendaItem, ...AgendaItem[]],
  snapshot: AgendaSnapshot,
): SessionNotificationPayload {
  const first = stopShows(waiting);
  const count = waiting.length;
  const name = agendaNotificationTitle(clipAtWord(oneLine(ferret), STOPPED_NAME_LENGTH));
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-stopped:${sessionId}`,
    sessionId,
    kind: 'attention',
    title: `${name} is stopped · ${count === 1 ? '1 needs you' : `${count} need you`}`,
    body: clipAtWord(oneLine(agendaTitle(first)), AGENDA_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: agendaNotificationPath(sessionId, first.id),
    count: agendaBadgeCount(snapshot),
  }) as SessionNotificationPayload;
}

/** "Needed in about 2 h" / "Needed in 25 min" / "Overdue", from the instants alone. */
export function timeLeftPhrase(neededBy: string | undefined, now: string): string {
  if (neededBy === undefined) return 'Needed soon';
  const minutes = Math.round((Date.parse(neededBy) - Date.parse(now)) / 60_000);
  if (Number.isNaN(minutes) || minutes <= 0) return 'Overdue';
  if (minutes < 60) return `Needed in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return `Needed in about ${hours} h`;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

/** Server-derived attribution for a board item the daemon chose to announce. */
export function agendaNotificationAttribution(item: AgendaItem): string {
  if (item.raisedBy === 'agent') {
    if (item.raisedBySession === null) throw new Error('agent-raised agenda item has no raising session');
    return `attention:agent:${item.raisedBySession}`;
  }
  return `attention:${item.raisedBy}`;
}

/** Latin look-alikes an agent could spell the reserved alert title with, folded to the letter they mimic. */
const CONFUSABLE_LETTERS: Readonly<Record<string, string>> = {
  а: 'a',
  в: 'b',
  е: 'e',
  і: 'i',
  ј: 'j',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ѕ: 's',
  ԁ: 'd',
  ԝ: 'w',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
};

/** The letters a reader sees, whatever script or accent spells them: `A nеw dévice!` → `anewdevice`. */
function letterSkeleton(text: string): string {
  return [...text.normalize('NFKD').toLowerCase()]
    .map(letter => CONFUSABLE_LETTERS[letter] ?? letter)
    .join('')
    .replaceAll(/[^a-z]/gu, '');
}

/**
 * What the reserved alert says, as letters: a name that reads as "new device" or "paired" anywhere is not a
 * ferret's to put on a lock screen bare. Derived from the alert's own title, so the two cannot drift.
 */
const RESERVED_ALERT_SKELETONS = [
  letterSkeleton(DEVICE_PAIRED_TITLE.split(' ').slice(1, 3).join(' ')),
  letterSkeleton(DEVICE_PAIRED_TITLE.split(' ').at(-1) ?? ''),
  // A ferret's own push must never read as the daemon's approve-on-phone push, whose number the owner taps.
  letterSkeleton(PHONE_APPROVAL_TITLE),
].filter(skeleton => skeleton !== '');

/**
 * An Attention push's title: the card's own, plain, trimmed to `AGENDA_PUSH_TITLE_LENGTH` at a word
 * boundary.
 *
 * A ferret chooses these words, so one that READS as the daemon's own new-device alert
 * (`DEVICE_PAIRED_TITLE`) or its approve-on-phone push (`PHONE_APPROVAL_TITLE`) — in any letters that look like
 * it (`letterSkeleton`) — is labelled, as
 * `Ferret “…”`, which no real alert ever opens with. Every other title is the words as written.
 */
export function agendaNotificationTitle(title: string): string {
  const name = oneLine(title);
  const letters = letterSkeleton(name);
  if (!RESERVED_ALERT_SKELETONS.some(reserved => letters.includes(reserved)))
    return clipAtWord(name, AGENDA_PUSH_TITLE_LENGTH);
  return `Ferret “${clipAtWord(name, AGENDA_PUSH_TITLE_LENGTH - 9)}”`;
}
