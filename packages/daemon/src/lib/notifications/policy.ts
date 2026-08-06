import {
  type AttentionItem,
  type AttentionSnapshot,
  type DirectNotificationRequest,
  type PushNotificationPayload,
  PushNotificationPayloadSchema,
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

/** Composes a filterable direct payload; an absent direct kind is a question. */
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
    title: request.title ?? sessionName,
    body: request.body,
    tag: `notify-${sessionId}`,
    url: '/',
    count: 1,
  }) as SessionNotificationPayload;
}

/** Composes the automatic presentation of one newly created board item. */
export function attentionNotificationPayload(
  sessionId: string,
  item: AttentionItem,
  snapshot: AttentionSnapshot,
): SessionNotificationPayload {
  return PushNotificationPayloadSchema.parse({
    version: 1,
    eventKey: 'attention-raised',
    sessionId,
    kind: 'attention',
    title: item.subject,
    body: item.why,
    tag: `attention-${sessionId}`,
    url: '/',
    count: snapshot.count,
  }) as SessionNotificationPayload;
}

/** Server-derived attribution for a board item the daemon chose to announce. */
export function attentionNotificationAttribution(item: AttentionItem): string {
  if (item.raisedBy === 'agent') {
    if (item.raisedBySession === null) throw new Error('agent-raised attention has no raising session');
    return `attention:agent:${item.raisedBySession}`;
  }
  return `attention:${item.raisedBy}`;
}
