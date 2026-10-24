import {
  type AttentionItem,
  type AttentionSnapshot,
  attentionNotificationPath,
  type DirectNotificationRequest,
  MAX_NOTIFICATION_BODY_LENGTH,
  MAX_NOTIFICATION_TITLE_LENGTH,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
  sessionNotificationPath,
} from '@ferretry/protocol';
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

/**
 * Composes the automatic presentation of one newly created board item: THE ONE PUSH A FERRET'S ASK
 * MAKES (docs/attention.md). Waiting and finishing push nothing; this does.
 *
 * Titled with the ferret that asks — quoted, FIRST — and then the ask, so a lock screen alone says who
 * wants what, and so an ask can never open with the daemon's own new-device alert title
 * (`DEVICE_PAIRED_TITLE`): the ask is an agent's words, exactly as a direct notification's title is. The
 * body is the context the ferret gave — what it is doing and why it needs this — falling back to its
 * `why`, then the choices it offered. A tap opens that conversation at the item: the path is relative
 * to the machine's own pages, which the browser's per-machine worker places under that machine.
 */
export function attentionNotificationPayload(
  sessionId: string,
  sessionName: string,
  item: AttentionItem,
  snapshot: AttentionSnapshot,
): SessionNotificationPayload {
  const context = item.context?.trim() || item.why;
  const options =
    item.ask?.kind === 'multiple-choice' ? `\n${item.ask.options.map(option => option.label).join(' · ')}` : '';
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: `attention-raised:${item.id}`,
    sessionId,
    kind: 'attention',
    title: clipped(`“${sessionName}”: ${item.subject}`, MAX_NOTIFICATION_TITLE_LENGTH),
    body: clipped(`${context === item.subject ? '' : context}${options}`.trim(), MAX_NOTIFICATION_BODY_LENGTH),
    tag: `attention-${sessionId}`,
    url: attentionNotificationPath(sessionId, item.id),
    count: snapshot.count,
  }) as SessionNotificationPayload;
}

/** One line of at most `limit` characters, ending in an ellipsis when it was cut. */
function clipped(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Server-derived attribution for a board item the daemon chose to announce. */
export function attentionNotificationAttribution(item: AttentionItem): string {
  if (item.raisedBy === 'agent') {
    if (item.raisedBySession === null) throw new Error('agent-raised attention has no raising session');
    return `attention:agent:${item.raisedBySession}`;
  }
  return `attention:${item.raisedBy}`;
}
