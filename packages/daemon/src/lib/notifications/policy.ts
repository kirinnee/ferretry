import {
  ATTENTION_PUSH_BODY_LENGTH,
  ATTENTION_PUSH_TITLE_LENGTH,
  type AttentionItem,
  type AttentionSnapshot,
  attentionNotificationPath,
  attentionTitle,
  clipAtWord,
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
  readonly attentionId: string;
  /** A notice's own push: it asked the phone to buzz (`fy notify --ping`). */
  readonly ping?: boolean;
  /** The one push an item makes when its `neededBy` comes within the warning window. */
  readonly deadline?: boolean;
  /** The one push a stop makes, named by the instant the ferret's turn boundary was recorded. */
  readonly stoppedAt?: string;
  /** @deprecated retired; ledgers written before the buzz policy carry it. */
  readonly infoRequest?: number;
  /** @deprecated retired; ledgers written before the buzz policy carry it. */
  readonly surfaced?: boolean;
}

export function notificationKey(identity: NotificationIdentity): string {
  // A stop is about the ferret, not about one of its items: the item that triggers it may change within
  // the stop, and the key must not.
  if (identity.stoppedAt !== undefined) return `attention:${identity.sessionId}:stopped:${identity.stoppedAt}`;
  const base = `attention:${identity.sessionId}:${identity.attentionId}`;
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
  item: AttentionItem,
  snapshot: AttentionSnapshot,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `notice-ping:${item.id}`,
    sessionId,
    kind: 'attention',
    title: attentionNotificationTitle(attentionTitle(item)),
    body: clipAtWord(oneLine(item.subject), ATTENTION_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, item.id),
    count: snapshot.count,
  }) as SessionNotificationPayload;
}

/**
 * What the one push says when an item's `neededBy` has come within the warning window: the card's title,
 * and the time left (or that it passed) ahead of its ask.
 */
export function deadlineNotificationPayload(
  sessionId: string,
  item: AttentionItem,
  snapshot: AttentionSnapshot,
  now: string,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-deadline:${item.id}`,
    sessionId,
    kind: 'attention',
    title: attentionNotificationTitle(attentionTitle(item)),
    body: clipAtWord(`${timeLeftPhrase(item.neededBy, now)}: ${oneLine(item.subject)}`, ATTENTION_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, item.id),
    count: snapshot.count,
  }) as SessionNotificationPayload;
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
  waiting: readonly [AttentionItem, ...AttentionItem[]],
  snapshot: AttentionSnapshot,
): SessionNotificationPayload {
  const first = waiting.find(item => item.blockingNow === true) ?? waiting[0];
  const count = waiting.length;
  const name = attentionNotificationTitle(clipAtWord(oneLine(ferret), STOPPED_NAME_LENGTH));
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-stopped:${sessionId}`,
    sessionId,
    kind: 'attention',
    title: `${name} is stopped · ${count === 1 ? '1 needs you' : `${count} need you`}`,
    body: clipAtWord(oneLine(attentionTitle(first)), ATTENTION_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, first.id),
    count: snapshot.count,
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
export function attentionNotificationAttribution(item: AttentionItem): string {
  if (item.raisedBy === 'agent') {
    if (item.raisedBySession === null) throw new Error('agent-raised attention has no raising session');
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
].filter(skeleton => skeleton !== '');

/**
 * An Attention push's title: the card's own, plain, trimmed to `ATTENTION_PUSH_TITLE_LENGTH` at a word
 * boundary.
 *
 * A ferret chooses these words, so one that READS as the daemon's own new-device alert
 * (`DEVICE_PAIRED_TITLE`) — in any letters that look like it (`letterSkeleton`) — is labelled, as
 * `Ferret “…”`, which no real alert ever opens with. Every other title is the words as written.
 */
export function attentionNotificationTitle(title: string): string {
  const name = oneLine(title);
  const letters = letterSkeleton(name);
  if (!RESERVED_ALERT_SKELETONS.some(reserved => letters.includes(reserved)))
    return clipAtWord(name, ATTENTION_PUSH_TITLE_LENGTH);
  return `Ferret “${clipAtWord(name, ATTENTION_PUSH_TITLE_LENGTH - 9)}”`;
}
