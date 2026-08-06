import { describe, it } from 'bun:test';
import {
  AttentionItemSchema,
  AttentionSnapshotSchema,
  PushNotificationPayloadSchema,
  type AttentionItem,
  type DirectNotificationRequest,
} from '@ferretry/protocol';
import should from 'should';
import {
  attentionNotificationAttribution,
  attentionNotificationPayload,
  decideNotificationReplay,
  directNotificationFingerprint,
  directNotificationPayload,
  notificationFingerprintMatches,
  notificationKey,
} from '../../../src/lib/notifications/policy.ts';
import {
  AttentionNotificationRequestedRecordSchema,
  NotificationOutcomeRecordSchema,
  NotificationRecordSchema,
  type DirectNotificationRequestedRecord,
  type NotificationLedgerEntry,
} from '../../../src/lib/notifications/types.ts';

const AT = '2026-08-06T09:00:00.000Z';
const REQUEST: DirectNotificationRequest = { body: 'The release needs review.' };

function directRequested(
  overrides: Partial<DirectNotificationRequestedRecord> = {},
): DirectNotificationRequestedRecord {
  return NotificationRecordSchema.parse({
    v: 1,
    phase: 'requested',
    key: 'direct:req-1',
    at: AT,
    origin: 'direct',
    attribution: 'peer:session-1',
    sessionId: 'session-1',
    request: { body: REQUEST.body, title: null, kind: null },
    sent: {
      kind: 'question',
      interactive: true,
      title: 'Release agent',
      body: REQUEST.body,
    },
    enrolled: 2,
    ...overrides,
  }) as DirectNotificationRequestedRecord;
}

function entry(
  outcome?: { readonly delivered: number; readonly failed?: number; readonly error?: string },
  requested = directRequested(),
): NotificationLedgerEntry {
  return {
    requested,
    ...(outcome === undefined
      ? {}
      : {
          outcome: NotificationOutcomeRecordSchema.parse({
            v: 1,
            phase: 'outcome',
            key: requested.key,
            at: AT,
            delivered: outcome.delivered,
            failed: outcome.failed ?? 0,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
          }),
        }),
  };
}

const item = AttentionItemSchema.parse({
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Choose a release window',
  why: 'The deployment needs a human decision.',
  waitingSince: AT,
  howToResolve: 'Choose a window.',
  ask: { kind: 'open-question' },
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Ada',
});

const snapshot = AttentionSnapshotSchema.parse({
  v: 1,
  sessionId: 'session-1',
  items: [item],
  resolved: [],
  count: 1,
  parseErrors: 0,
  updatedAt: AT,
});

describe('notification policy', () => {
  it('should namespace caller identities and include the session in attention identities', () => {
    // Arrange / Act
    const direct = notificationKey({ origin: 'direct', requestId: 'attention:session-1:A1' });
    const firstA1 = notificationKey({ origin: 'attention', sessionId: 'session-1', attentionId: 'A1' });
    const secondA1 = notificationKey({ origin: 'attention', sessionId: 'session-2', attentionId: 'A1' });

    // Assert
    should(direct).equal('direct:attention:session-1:A1');
    should(firstA1).equal('attention:session-1:A1');
    should(secondA1).equal('attention:session-2:A1');
    should(direct).not.equal(firstA1);
    should(firstA1).not.equal(secondA1);
  });

  it('should fingerprint all five accepted caller facts and ignore derived delivery facts', () => {
    // Arrange
    const incoming = directNotificationFingerprint('session-1', REQUEST, 'peer:session-1', 'req-1');
    const base = directRequested();
    const variants: readonly DirectNotificationRequestedRecord[] = [
      { ...base, request: { ...base.request, body: 'different' } },
      { ...base, request: { ...base.request, title: 'Different title' } },
      { ...base, request: { ...base.request, kind: 'failed' } },
      { ...base, attribution: 'admin-cli' },
      { ...base, sessionId: 'session-2' },
    ];
    const derivedChanged = {
      ...base,
      sent: { ...base.sent, interactive: false, title: 'Renamed session' },
      enrolled: 99,
    };

    // Act + Assert
    should(notificationFingerprintMatches(base, incoming)).be.true();
    for (const variant of variants) should(notificationFingerprintMatches(variant, incoming)).be.false();
    should(notificationFingerprintMatches(derivedChanged, incoming)).be.true();
  });

  it('should decide every durable replay state without treating zero delivery as new', () => {
    // Arrange
    const incoming = directNotificationFingerprint('session-1', REQUEST, 'peer:session-1', 'req-1');
    const mismatch = entry(undefined, directRequested({ sessionId: 'session-2' }));

    // Act
    const fresh = decideNotificationReplay(undefined, incoming);
    const different = decideNotificationReplay(mismatch, incoming);
    const settled = decideNotificationReplay(entry({ delivered: 2, failed: 1 }), incoming);
    const zero = decideNotificationReplay(entry({ delivered: 0 }), incoming);
    const errored = decideNotificationReplay(entry({ delivered: 0, error: 'transport unavailable' }), incoming);
    const dangling = decideNotificationReplay(entry(), incoming);

    // Assert
    should(fresh).deepEqual({ decision: 'deliver' });
    should(different).containDeep({ decision: 'refuse', result: { ok: false, error: { code: 'invalid' } } });
    should(settled).deepEqual({ decision: 'replay', delivered: 2, sessionId: 'session-1' });
    should(zero).deepEqual({ decision: 'replay', delivered: 0, sessionId: 'session-1' });
    should(errored).containDeep({ decision: 'refuse', result: { ok: false, error: { code: 'corrupt' } } });
    should(dangling).containDeep({ decision: 'refuse', result: { ok: false, error: { code: 'corrupt' } } });
  });

  it('should refuse a differently originated record even when its key is hand-planted', () => {
    // Arrange
    const incoming = directNotificationFingerprint('session-1', REQUEST, 'peer:session-1', 'req-1');
    const attention = AttentionNotificationRequestedRecordSchema.parse({
      v: 1,
      phase: 'requested',
      key: 'attention:session-1:A1',
      at: AT,
      origin: 'attention',
      attribution: 'attention:agent:session-1',
      sessionId: 'session-1',
      attentionId: 'A1',
      sent: { kind: 'attention', interactive: true, title: item.subject, body: item.why },
      enrolled: 1,
    });

    // Act
    const actual = decideNotificationReplay({ requested: attention }, incoming);

    // Assert
    should(actual).containDeep({ decision: 'refuse', result: { error: { code: 'invalid' } } });
  });

  it('should compose schema-valid direct and attention payloads with honest defaults and tags', () => {
    // Arrange / Act
    const generic = directNotificationPayload('session-1', 'Release agent', REQUEST);
    const explicit = directNotificationPayload('session-1', 'Release agent', {
      body: 'The deployment failed.',
      title: 'Deploy failed',
      kind: 'failed',
    });
    const automatic = attentionNotificationPayload('session-1', item, snapshot);

    // Assert
    should(generic).containDeep({ kind: 'question', title: 'Release agent', tag: 'notify-session-1' });
    should(explicit).containDeep({ kind: 'failed', title: 'Deploy failed', tag: 'notify-session-1' });
    should(automatic).containDeep({
      eventKey: 'attention-raised',
      kind: 'attention',
      title: item.subject,
      body: item.why,
      tag: 'attention-session-1',
      count: 1,
    });
    for (const payload of [generic, explicit, automatic]) {
      should(PushNotificationPayloadSchema.safeParse(payload).success).be.true();
    }
  });

  it('should derive every automatic attribution and refuse malformed agent provenance', () => {
    // Arrange
    const human = { ...item, raisedBy: 'human' as const, raisedBySession: null, raisedByName: null };
    const daemon = { ...item, raisedBy: 'daemon' as const, raisedBySession: null, raisedByName: null };
    const malformed = { ...item, raisedBySession: null } as unknown as AttentionItem;

    // Act + Assert
    should(attentionNotificationAttribution(item)).equal('attention:agent:session-1');
    should(attentionNotificationAttribution(human)).equal('attention:human');
    should(attentionNotificationAttribution(daemon)).equal('attention:daemon');
    should(() => attentionNotificationAttribution(malformed)).throw(/no raising session/u);
  });
});
