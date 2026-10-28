import {
  ATTENTION_PUSH_BODY_LENGTH,
  ATTENTION_PUSH_TITLE_LENGTH,
  type AttentionItem,
  type AttentionSnapshot,
  attentionNotificationPath,
  type DirectNotificationRequest,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
  sessionNotificationPath,
} from '@ferretry/protocol';
import { DEVICE_PAIRED_TITLE } from '../audit/policy.ts';
import type { DirectNotificationRequestedRecord, NotificationLedgerEntry, NotificationResult } from './types.ts';

export type SessionNotificationPayload = Extract<PushNotificationPayload, { readonly sessionId: string }>;

export type NotificationIdentity =
  | { readonly origin: 'direct'; readonly requestId: string }
  | { readonly origin: 'attention'; readonly sessionId: string; readonly attentionId: string };

/** The daemon-wide identity of one logical notification. */
export function notificationKey(identity: NotificationIdentity): string {
  return identity.origin === 'direct'
    ? `direct:${identity.requestId}`
    : `attention:${identity.sessionId}:${identity.attentionId}`;
}

export interface DirectNotificationFingerprint {
  readonly requestId: string;
  readonly attribution: string;
  readonly sessionId: string;
  readonly request: {
    readonly body: string;
    readonly title: string | null;
    readonly kind: 'completed' | 'failed' | null;
  };
}

/** The caller's accepted claim plus the server-derived actor, excluding mutable daemon facts. */
export function directNotificationFingerprint(
  sessionId: string,
  request: DirectNotificationRequest,
  attribution: string,
  requestId: string,
): DirectNotificationFingerprint {
  return {
    requestId,
    attribution,
    sessionId,
    request: {
      body: request.body,
      title: request.title ?? null,
      kind: request.kind ?? null,
    },
  };
}

/** Whether a stored direct request names exactly the same accepted caller claim. */
export function notificationFingerprintMatches(
  stored: DirectNotificationRequestedRecord,
  incoming: DirectNotificationFingerprint,
): boolean {
  return (
    stored.attribution === incoming.attribution &&
    stored.sessionId === incoming.sessionId &&
    stored.request.body === incoming.request.body &&
    stored.request.title === incoming.request.title &&
    stored.request.kind === incoming.request.kind
  );
}

export type NotificationReplayDecision =
  | { readonly decision: 'deliver' }
  | { readonly decision: 'replay'; readonly delivered: number; readonly sessionId: string }
  | { readonly decision: 'refuse'; readonly result: NotificationResult<never> };

/** Decides a direct retry entirely from immutable accepted-request evidence. */
export function decideNotificationReplay(
  existing: NotificationLedgerEntry | undefined,
  incoming: DirectNotificationFingerprint,
): NotificationReplayDecision {
  if (existing === undefined) return { decision: 'deliver' };
  if (existing.requested.origin !== 'direct' || !notificationFingerprintMatches(existing.requested, incoming)) {
    return {
      decision: 'refuse',
      result: {
        ok: false,
        error: {
          code: 'invalid',
          message: `request id ${incoming.requestId} already named a different notification: one request id names one notification`,
        },
      },
    };
  }
  if (existing.outcome === undefined) {
    return {
      decision: 'refuse',
      result: {
        ok: false,
        error: {
          code: 'corrupt',
          message:
            'this notification was accepted and its delivery outcome was never recorded; it will not be sent again under this id',
        },
      },
    };
  }
  if (existing.outcome.error !== undefined) {
    return {
      decision: 'refuse',
      result: {
        ok: false,
        error: {
          code: 'corrupt',
          message: `notification delivery failed at ${existing.outcome.at}: ${existing.outcome.error}`,
        },
      },
    };
  }
  return {
    decision: 'replay',
    delivered: existing.outcome.delivered,
    sessionId: existing.requested.sessionId,
  };
}

/**
 * Composes a filterable direct payload; an absent direct kind is a question.
 *
 * THE TITLE ALWAYS SAYS WHICH AGENT SENT IT. An agent chooses its own words, so its title is printed
 * after `Agent “name”:` and can never open with the daemon's own new-device alert title (see
 * `DEVICE_PAIRED_TITLE`) — nor can its fixed eventKey and tag carry that alert's reserved prefix.
 *
 * A tap opens the agent's conversation (`sessionNotificationPath`), placed under the machine by the
 * browser's push worker — it used to open the app root, which is a machine's session list.
 */
export function directNotificationPayload(
  sessionId: string,
  sessionName: string,
  request: DirectNotificationRequest,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: 'direct-notification',
    sessionId,
    kind: request.kind ?? 'question',
    title: `Agent “${sessionName}”${request.title === undefined ? '' : `: ${request.title}`}`,
    body: request.body,
    tag: `notify-${sessionId}`,
    url: sessionNotificationPath(sessionId),
    count: 1,
  }) as SessionNotificationPayload;
}

/** The two names an Attention push is titled with: the conversation, else the ferret. */
export interface AttentionNotificationSession {
  /** The ferret's spoken name (`agentSpokenName`). */
  readonly name: string;
  /** The conversation's name — the session's task title — when it has one. */
  readonly title?: string;
}

/**
 * Composes the automatic presentation of one newly created board item: THE ONE PUSH A FERRET'S ASK
 * MAKES (docs/attention.md). Waiting and finishing push nothing; this does.
 *
 * A LOCK SCREEN GETS A CONCISE SUMMARY AND NOTHING ELSE. The title is the conversation's name
 * (`attentionNotificationTitle`); the body is the item's summary alone, trimmed to
 * `ATTENTION_PUSH_BODY_LENGTH` at a word boundary — never the context, the options or any jargon, which
 * the item itself carries.
 *
 * A tap opens that conversation at the item: the path is relative to the machine's own pages, which the
 * browser's per-machine worker places under that machine.
 */
export function attentionNotificationPayload(
  sessionId: string,
  session: AttentionNotificationSession,
  item: AttentionItem,
  snapshot: AttentionSnapshot,
): SessionNotificationPayload {
  const conversation = session.title?.trim() || session.name;
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-raised:${item.id}`,
    sessionId,
    kind: 'attention',
    title: attentionNotificationTitle(conversation),
    body: clippedAtWord(attentionNotificationSummary(item, conversation), ATTENTION_PUSH_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, item.id),
    count: snapshot.count,
  }) as SessionNotificationPayload;
}

/** The item's summary, or its first question when the summary only repeats the title (or is empty). */
export function attentionNotificationSummary(item: AttentionItem, conversation: string): string {
  const first = item.questions?.[0]?.question;
  const summary = oneLine(item.subject);
  return first !== undefined && (summary === '' || sameWords(summary, conversation)) ? oneLine(first) : summary;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, ' ').trim();
}

function sameWords(left: string, right: string): boolean {
  return oneLine(left).toLowerCase() === oneLine(right).toLowerCase();
}

/**
 * One line of at most `limit` characters. A longer text is cut at the last word that fits and ends in an
 * ellipsis; a single word longer than the limit is cut where it stands.
 */
export function clippedAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const room = text.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:.\-–—]+$/u, '')}…`;
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
 * An Attention push's title: the conversation's name, plain, trimmed to `ATTENTION_PUSH_TITLE_LENGTH`
 * at a word boundary.
 *
 * IT USED TO BE QUOTED, ALWAYS — `“Ferretry”` on the lock screen — so that an agent's words could never
 * open with the daemon's own new-device alert (`DEVICE_PAIRED_TITLE`). The owner read the quotes as a
 * defect, and they guarded every title for the sake of one. Now only a name that READS as that alert —
 * in any letters that look like it (`letterSkeleton`) — is labelled, as `Ferret “…”`, which no real
 * alert ever opens with. Every other title is the name as the owner typed it.
 */
export function attentionNotificationTitle(conversation: string): string {
  const name = oneLine(conversation);
  const letters = letterSkeleton(name);
  if (!RESERVED_ALERT_SKELETONS.some(reserved => letters.includes(reserved)))
    return clippedAtWord(name, ATTENTION_PUSH_TITLE_LENGTH);
  return `Ferret “${clippedAtWord(name, ATTENTION_PUSH_TITLE_LENGTH - 9)}”`;
}
