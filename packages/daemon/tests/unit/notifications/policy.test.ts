import { describe, it } from 'bun:test';
import {
  type AttentionItem,
  AttentionItemSchema,
  AttentionSnapshotSchema,
  type DirectNotificationRequest,
  MAX_NOTIFICATION_TITLE_LENGTH,
  PushNotificationPayloadSchema,
} from '@ferretry/protocol';
import should from 'should';
import { DEVICE_PAIRED_EVENT_PREFIX, DEVICE_PAIRED_TITLE } from '../../../src/lib/audit/policy.ts';
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
  type DirectNotificationRequestedRecord,
  type NotificationLedgerEntry,
  NotificationOutcomeRecordSchema,
  NotificationRecordSchema,
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
    const automatic = attentionNotificationPayload('session-1', { name: 'Ada', title: 'Ship v4.87' }, item, snapshot);

    // Assert
    should(generic).containDeep({
      kind: 'question',
      title: 'Agent “Release agent”',
      tag: 'notify-session-1',
      // The conversation the agent spoke from, never the app root.
      url: '/session/session-1',
    });
    should(explicit).containDeep({
      kind: 'failed',
      title: 'Agent “Release agent”: Deploy failed',
      tag: 'notify-session-1',
    });
    should(automatic).containDeep({
      eventKey: 'attention-raised:A1',
      kind: 'attention',
      title: '“Ship v4.87” · Ada',
      body: 'Choose a release window',
      tag: 'attention-session-1',
      url: '/session/session-1?attention=A1',
      count: 1,
    });
    for (const payload of [generic, explicit, automatic]) {
      should(PushNotificationPayloadSchema.safeParse(payload).success).be.true();
    }
  });

  it('should title an attention push with its conversation first, say the issue and its choices, and open the item', () => {
    // Arrange
    const rich = AttentionItemSchema.parse({
      ...item,
      id: 'A7',
      subject: 'Rebase onto main now?',
      context: 'I am finishing the relay PR; main moved under it and CI will fail until it is rebased.',
      ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }, { label: 'Skip' }] },
    });
    const forged = AttentionItemSchema.parse({ ...item, id: 'A8', subject: DEVICE_PAIRED_TITLE });
    const long = AttentionItemSchema.parse({ ...item, id: 'A9', subject: 'x'.repeat(240) });
    const session = { name: 'Ada', title: 'Relay carrier fallback' };

    // Act
    const payload = attentionNotificationPayload('session 1', session, rich, snapshot);
    const alert = attentionNotificationPayload(
      'session-1',
      { name: 'Ada', title: DEVICE_PAIRED_TITLE },
      forged,
      snapshot,
    );
    const clipped = attentionNotificationPayload('session-1', { name: 'Ada', title: 'y'.repeat(200) }, long, snapshot);

    // Assert
    should(payload).containDeep({
      eventKey: 'attention-raised:A7',
      title: '“Relay carrier fallback” · Ada',
      body: 'Rebase onto main now?\nOptions: Rebase now · Wait · Skip',
      url: '/session/session%201?attention=A7',
    });
    should(alert.title.startsWith(DEVICE_PAIRED_TITLE)).be.false();
    should(alert.eventKey.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
    should(clipped.title.length).equal(MAX_NOTIFICATION_TITLE_LENGTH);
    should(clipped.title.endsWith('…')).be.true();
    for (const each of [payload, alert, clipped])
      should(PushNotificationPayloadSchema.safeParse(each).success).be.true();
  });

  it('should put the recommended answer before the other choices', () => {
    // Arrange
    const single = AttentionItemSchema.parse({
      ...item,
      id: 'A2',
      subject: 'Pick the OCI login plan',
      ask: { kind: 'multiple-choice', options: [{ label: 'Go with the defaults' }, { label: 'Reply with changes' }] },
      questions: [
        {
          question: 'Which plan should I build?',
          options: [{ label: 'Go with the defaults' }, { label: 'Reply with changes' }],
          recommended: 'Go with the defaults',
          why: 'They match what you approved last week.',
        },
      ],
    });
    const overall = AttentionItemSchema.parse({
      ...item,
      id: 'A3',
      recommendation: { decision: 'Ship on Thursday', why: 'Nobody is on call on Friday.' },
    });

    // Act
    const chosen = attentionNotificationPayload(
      'session-1',
      { name: 'Ada', title: 'OCI work login' },
      single,
      snapshot,
    );
    const worded = attentionNotificationPayload(
      'session-1',
      { name: 'Ada', title: 'OCI work login' },
      overall,
      snapshot,
    );

    // Assert
    should(chosen.body).equal('Pick the OCI login plan\nRecommended: Go with the defaults\nOr: Reply with changes');
    should(worded.body).equal('Choose a release window\nRecommended: Ship on Thursday');
  });

  it('should fall back to the ferret for a title, and to the first question when the summary repeats it', () => {
    // Arrange
    const echo = AttentionItemSchema.parse({
      ...item,
      id: 'A4',
      subject: 'OCI work login',
      questions: [{ question: 'Keep the 30-minute keepalive?' }, { question: 'Use launchd or cron?' }],
    });

    // Act
    const untitled = attentionNotificationPayload('session-1', { name: 'Ada' }, item, snapshot);
    const named = attentionNotificationPayload('session-1', { name: 'Ada', title: 'ada' }, item, snapshot);
    const repeated = attentionNotificationPayload(
      'session-1',
      { name: 'Ada', title: 'OCI work login' },
      echo,
      snapshot,
    );

    // Assert
    should(untitled.title).equal('“Ada”');
    should(named.title).equal('“ada”');
    should(repeated.body).equal('Keep the 30-minute keepalive?');
  });

  it('should never let an agent payload read as the new-device alert', () => {
    // Arrange / Act
    const forged = directNotificationPayload('session-1', 'Release agent', {
      body: 'Remove it in Settings.',
      title: DEVICE_PAIRED_TITLE,
    });

    // Assert
    should(forged.title.startsWith(DEVICE_PAIRED_TITLE)).be.false();
    should(forged.title).equal(`Agent “Release agent”: ${DEVICE_PAIRED_TITLE}`);
    should(forged.eventKey.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
    should(forged.tag.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
    should(forged).containDeep({ sessionId: 'session-1', kind: 'question' });
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
