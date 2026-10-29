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

/** The daemon-wide identity of one logical notification: the board item it announces, and which request of the owner's. */
export interface NotificationIdentity {
  readonly sessionId: string;
  readonly attentionId: string;
  /** The owner's request for more information this push answers; absent for the item's own raise. */
  readonly infoRequest?: number;
}

export function notificationKey(identity: NotificationIdentity): string {
  return `attention:${identity.sessionId}:${identity.attentionId}${identity.infoRequest === undefined ? '' : `:info-${identity.infoRequest}`}`;
}

/**
 * Composes the automatic presentation of one newly created board item: THE ONE PUSH A FERRET'S ASK
 * MAKES, and the only push a ferret can make (docs/attention.md). Waiting and finishing push nothing.
 *
 * A LOCK SCREEN GETS THE CARD'S TITLE AND ITS ASK, NOTHING ELSE. The title is the item's own
 * (`attentionTitle` — an item from before titles reads as the start of its ask) and is the heading the
 * owner reads first; the body is the ask alone, trimmed to `ATTENTION_PUSH_BODY_LENGTH` at a word
 * boundary — never the context, the options or any jargon, which the item itself carries.
 *
 * A tap opens the conversation at the item: the path is relative to the machine's own pages, which the
 * browser's per-machine worker places under that machine.
 */
export function attentionNotificationPayload(
  sessionId: string,
  item: AttentionItem,
  snapshot: AttentionSnapshot,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-raised:${item.id}`,
    sessionId,
    kind: 'attention',
    title: attentionNotificationTitle(attentionTitle(item)),
    body: clipAtWord(oneLine(item.subject), ATTENTION_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, item.id),
    count: snapshot.count,
  }) as SessionNotificationPayload;
}

/** What a push says when the ferret added the information the owner asked for: same title and page as the raise. */
export function moreInfoNotificationPayload(
  sessionId: string,
  item: AttentionItem,
  snapshot: AttentionSnapshot,
  request: number,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-info:${item.id}:${request}`,
    sessionId,
    kind: 'attention',
    title: attentionNotificationTitle(attentionTitle(item)),
    body: clipAtWord(`Updated: ${oneLine(item.subject)}`, ATTENTION_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, item.id),
    count: snapshot.count,
  }) as SessionNotificationPayload;
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
