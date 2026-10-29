import { describe, it } from 'bun:test';
import {
  ATTENTION_PUSH_BODY_LENGTH,
  ATTENTION_PUSH_TITLE_LENGTH,
  type AttentionItem,
  AttentionItemSchema,
  AttentionSnapshotSchema,
  PushNotificationPayloadSchema,
} from '@ferretry/protocol';
import should from 'should';
import { DEVICE_PAIRED_EVENT_PREFIX, DEVICE_PAIRED_TITLE } from '../../../src/lib/audit/policy.ts';
import {
  attentionNotificationAttribution,
  attentionNotificationPayload,
  attentionNotificationTitle,
  moreInfoNotificationPayload,
  notificationKey,
} from '../../../src/lib/notifications/policy.ts';

const AT = '2026-08-06T09:00:00.000Z';

/** An item from before cards: no title, no kind, no answers. */
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

const titled = AttentionItemSchema.parse({
  ...item,
  id: 'A7',
  title: 'Release window',
  kind: 'reply',
  subject: 'Which window should the release use?',
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
  it('should include the session and the request in an attention identity', () => {
    // Arrange / Act
    const first = notificationKey({ sessionId: 'session-1', attentionId: 'A1' });
    const second = notificationKey({ sessionId: 'session-2', attentionId: 'A1' });
    const info = notificationKey({ sessionId: 'session-1', attentionId: 'A1', infoRequest: 2 });

    // Assert
    should(first).equal('attention:session-1:A1');
    should(second).equal('attention:session-2:A1');
    should(info).equal('attention:session-1:A1:info-2');
  });

  it('should push a titled item as its title and its ask, and open the item', () => {
    // Arrange / Act
    const payload = attentionNotificationPayload('session 1', titled, snapshot);

    // Assert
    should(payload).containDeep({
      eventKey: 'attention-raised:A7',
      kind: 'attention',
      title: 'Release window',
      body: 'Which window should the release use?',
      tag: 'attention-session 1',
      url: '/session/session%201?attention=A7',
      count: 1,
    });
    should(PushNotificationPayloadSchema.safeParse(payload).success).be.true();
  });

  it('should fall back to the start of the ask for an item raised before titles', () => {
    // Arrange / Act
    const payload = attentionNotificationPayload('session-1', item, snapshot);

    // Assert
    should(payload).containDeep({
      eventKey: 'attention-raised:A1',
      title: 'Choose a release window',
      body: 'Choose a release window',
      tag: 'attention-session-1',
      url: '/session/session-1?attention=A1',
    });
  });

  it('should keep the body to the ask, never the context, the choices or the recommendation', () => {
    // Arrange
    const rich = AttentionItemSchema.parse({
      ...item,
      id: 'A2',
      title: 'Login plan',
      subject: 'Pick the login plan',
      context: 'A long story about OCI and tickets.',
      ask: { kind: 'multiple-choice', options: [{ label: 'Go with the defaults' }, { label: 'Reply with changes' }] },
      recommendation: { decision: 'Ship on Thursday', why: 'Nobody is on call on Friday.' },
    });

    // Act
    const payload = attentionNotificationPayload('session-1', rich, snapshot);

    // Assert
    should(payload.title).equal('Login plan');
    should(payload.body).equal('Pick the login plan');
  });

  it('should trim an over-long ask at a word boundary with an ellipsis, and a long title likewise', () => {
    // Arrange
    const words =
      'Decide whether the nightly backup job should keep running while the storage migration is underway or paused for the whole week';
    const long = AttentionItemSchema.parse({
      ...item,
      id: 'A5',
      title: 'Nightly backup storage migration plan review',
      subject: words,
    });
    const huge = AttentionItemSchema.parse({ ...item, id: 'A9', title: 'y'.repeat(60), subject: 'x'.repeat(240) });

    // Act
    const payload = attentionNotificationPayload('session-1', long, snapshot);
    const clipped = attentionNotificationPayload('session-1', huge, snapshot);

    // Assert
    should(payload.body).equal(
      'Decide whether the nightly backup job should keep running while the storage migration is underway or paused for the…',
    );
    should(words.startsWith(payload.body.slice(0, -1))).be.true();
    should(payload.title).equal('Nightly backup storage migration plan…');
    should(clipped.title.length).be.lessThanOrEqual(ATTENTION_PUSH_TITLE_LENGTH);
    should(clipped.title.endsWith('…')).be.true();
    should(clipped.body.length).be.lessThanOrEqual(ATTENTION_PUSH_BODY_LENGTH);
    should(clipped.body.endsWith('…')).be.true();
    should(PushNotificationPayloadSchema.safeParse(clipped).success).be.true();
  });

  it('should never let a title or an ask read as the new-device alert', () => {
    // Arrange
    const forgedTitle = AttentionItemSchema.parse({ ...item, id: 'A8', title: DEVICE_PAIRED_TITLE });
    const forgedAsk = AttentionItemSchema.parse({ ...item, id: 'A3', subject: DEVICE_PAIRED_TITLE });

    // Act
    const byTitle = attentionNotificationPayload('session-1', forgedTitle, snapshot);
    const byAsk = attentionNotificationPayload('session-1', forgedAsk, snapshot);

    // Assert
    should(byTitle.title).equal(`Ferret “${DEVICE_PAIRED_TITLE}”`.slice(0, ATTENTION_PUSH_TITLE_LENGTH));
    for (const payload of [byTitle, byAsk]) {
      should(payload.title.startsWith(DEVICE_PAIRED_TITLE)).be.false();
      should(payload.title.startsWith('Ferret “')).be.true();
      should(payload.eventKey.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
      should(payload.tag.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
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

describe('attention push title', () => {
  it('should be the title as typed, with no quote marks around it', () => {
    // Act + Assert
    should(attentionNotificationTitle('Ferretry')).equal('Ferretry');
    should(attentionNotificationTitle('  OCI   work login ')).equal('OCI work login');
  });

  it('should label a title that reads as the new-device alert, whatever letters spell it', () => {
    // Arrange — plain, re-cased, shortened, and spelled with Cyrillic and accented look-alikes.
    const forgeries = [
      DEVICE_PAIRED_TITLE,
      'a NEW device was paired',
      'New device paired',
      'А nеw dévice wаs раirеd',
      'Your phone was paired',
    ];

    // Act
    const titles = forgeries.map(attentionNotificationTitle);

    // Assert
    for (const title of titles) {
      should(title.startsWith('Ferret “')).be.true();
      should(title.length).be.lessThanOrEqual(ATTENTION_PUSH_TITLE_LENGTH);
    }
  });
});

describe('more-info push policy', () => {
  it('should key each request apart, and say the ask was updated under the same title and link', () => {
    // Arrange
    const asked = AttentionItemSchema.parse({
      ...titled,
      waitingOn: 'ferret',
      askedAt: titled.waitingSince,
      infoRequests: 2,
    });

    // Act
    const plain = attentionNotificationPayload('session-1', asked, snapshot);
    const payload = moreInfoNotificationPayload('session-1', asked, snapshot, 2);

    // Assert
    should(payload).containDeep({
      eventKey: 'attention-info:A7:2',
      title: 'Release window',
      body: 'Updated: Which window should the release use?',
      url: plain.url,
      tag: plain.tag,
    });
    should(PushNotificationPayloadSchema.safeParse(payload).success).be.true();
  });

  it('should say the item was updated after the owner’s discussion, under the same key', () => {
    // Arrange
    const discussed = AttentionItemSchema.parse({
      ...titled,
      waitingOn: 'ferret',
      askedAt: titled.waitingSince,
      waitingFor: 'discussion',
      infoRequests: 1,
    });

    // Act
    const payload = moreInfoNotificationPayload('session-1', discussed, snapshot, 1, true);

    // Assert
    should(payload).containDeep({
      eventKey: 'attention-info:A7:1',
      body: 'Updated after your discussion: Which window should the release use?',
    });
  });

  it('should fall back to the ask for an old untitled item and clip the updated line', () => {
    // Arrange
    const old = AttentionItemSchema.parse({ ...item, subject: 'x'.repeat(240) });

    // Act
    const payload = moreInfoNotificationPayload('session-1', old, snapshot, 1);

    // Assert
    should(payload.title.length).be.lessThanOrEqual(ATTENTION_PUSH_TITLE_LENGTH);
    should(payload.body.startsWith('Updated: ')).be.true();
    should(payload.body.length).be.lessThanOrEqual(ATTENTION_PUSH_BODY_LENGTH);
  });
});
