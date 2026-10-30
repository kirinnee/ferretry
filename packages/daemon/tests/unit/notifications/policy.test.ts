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
import { z } from 'zod';
import { DEVICE_PAIRED_EVENT_PREFIX, DEVICE_PAIRED_TITLE } from '../../../src/lib/audit/policy.ts';
import {
  attentionNotificationAttribution,
  attentionNotificationTitle,
  deadlineNotificationPayload,
  legacyNotificationKey,
  normalizedNotificationKey,
  notificationKey,
  pingNotificationPayload,
  stoppedNotificationPayload,
  timeLeftPhrase,
} from '../../../src/lib/notifications/policy.ts';

const AT = '2026-08-06T09:00:00.000Z';

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
  items: [item, titled],
  resolved: [],
  count: 2,
  parseErrors: 0,
  updatedAt: AT,
});

describe('notification keys', () => {
  it('should name each of the three buzz reasons apart, per session and item', () => {
    // Arrange / Act
    const keys = [
      notificationKey({ sessionId: 'session-1', attentionId: 'A1', ping: true }),
      notificationKey({ sessionId: 'session-1', attentionId: 'A1', deadline: true }),
      notificationKey({ sessionId: 'session-1', attentionId: 'A1', stoppedAt: AT }),
      notificationKey({ sessionId: 'session-1', attentionId: 'A2', stoppedAt: AT }),
      notificationKey({ sessionId: 'session-2', attentionId: 'A1', ping: true }),
    ];

    // Assert — a stop is the ferret's, whichever of its items triggered it.
    should(keys[0]).equal('agenda:session-1:A1:ping');
    should(keys[1]).equal('agenda:session-1:A1:deadline');
    should(keys[2]).equal(`agenda:session-1:stopped:${AT}`);
    should(keys[3]).equal(keys[2]);
    should(new Set([keys[0], keys[1], keys[2], keys[4]]).size).equal(4);
  });

  it('should keep reading the keys an earlier daemon wrote', () => {
    should(notificationKey({ sessionId: 'session-1', attentionId: 'A1' })).equal('agenda:session-1:A1');
    should(notificationKey({ sessionId: 'session-1', attentionId: 'A1', infoRequest: 2 })).equal(
      'agenda:session-1:A1:info-2',
    );
    should(notificationKey({ sessionId: 'session-1', attentionId: 'A1', surfaced: true })).equal(
      'agenda:session-1:A1:surfaced',
    );
  });
});

describe('stopped push', () => {
  it('should say who stopped and how many need them, and open the first item', () => {
    // Act
    const payload = stoppedNotificationPayload('session-1', 'Release agent', [item, titled], snapshot);

    // Assert
    should(payload.title).equal('Release agent is stopped · 2 need you');
    should(payload.body).equal('Choose a release window');
    should(payload.url).equal('/session/session-1?attention=A1');
    should(PushNotificationPayloadSchema.safeParse(payload).success).be.true();
  });

  it('should say "1 needs you", open the blocking item first, and keep the count past a long name', () => {
    // Arrange
    const blocking = AttentionItemSchema.parse({ ...titled, blockingNow: true });

    // Act
    const one = stoppedNotificationPayload('session-1', 'Release agent', [item], snapshot);
    const many = stoppedNotificationPayload('session-1', 'x'.repeat(80), [item, blocking], snapshot);

    // Assert
    should(one.title).equal('Release agent is stopped · 1 needs you');
    should(many.title.endsWith('is stopped · 2 need you')).be.true();
    should(many.url).equal('/session/session-1?attention=A7');
    should(many.title.length).be.belowOrEqual(ATTENTION_PUSH_TITLE_LENGTH + 40);
  });

  it('should never let a ferret name read as the new-device alert', () => {
    // Act
    const payload = stoppedNotificationPayload('session-1', DEVICE_PAIRED_TITLE, [item], snapshot);

    // Assert
    should(payload.title.startsWith(DEVICE_PAIRED_TITLE)).be.false();
    should(payload.eventKey.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
  });
});

describe('deadline push', () => {
  it('should lead with the time left, then the ask, and open the item', () => {
    // Arrange
    const due = AttentionItemSchema.parse({ ...titled, neededBy: '2026-08-06T11:00:00.000Z' });

    // Act
    const payload = deadlineNotificationPayload('session-1', due, snapshot, AT);

    // Assert
    should(payload.title).equal('Release window');
    should(payload.body).equal('Needed in about 2 h: Which window should the release use?');
    should(payload.url).equal('/session/session-1?attention=A7');
    should(payload.body.length).be.belowOrEqual(ATTENTION_PUSH_BODY_LENGTH);
  });

  it('should phrase minutes, hours and a passed deadline from the instants alone', () => {
    should(timeLeftPhrase('2026-08-06T09:25:00.000Z', AT)).equal('Needed in 25 min');
    should(timeLeftPhrase('2026-08-06T12:00:00.000Z', AT)).equal('Needed in about 3 h');
    should(timeLeftPhrase('2026-08-06T08:00:00.000Z', AT)).equal('Overdue');
    should(timeLeftPhrase(undefined, AT)).equal('Needed soon');
  });
});

describe('ping push', () => {
  it('should be the notice title and summary, opening the notice', () => {
    // Arrange
    const notice = AttentionItemSchema.parse({ ...titled, notice: true, ping: true, subject: 'Build is green' });

    // Act
    const payload = pingNotificationPayload('session-1', notice, snapshot);

    // Assert
    should(payload.title).equal('Release window');
    should(payload.body).equal('Build is green');
    should(payload.url).equal('/session/session-1?attention=A7');
    should(payload.eventKey).equal('notice-ping:A7');
  });

  it('should never let a title or a summary read as the new-device alert', () => {
    // Arrange
    const forgedTitle = AttentionItemSchema.parse({ ...item, id: 'A8', title: DEVICE_PAIRED_TITLE });

    // Act
    const payload = pingNotificationPayload('session-1', forgedTitle, snapshot);

    // Assert
    should(payload.title).equal(`Ferret “${DEVICE_PAIRED_TITLE}”`.slice(0, ATTENTION_PUSH_TITLE_LENGTH));
    should(payload.eventKey.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
    should(payload.tag.startsWith(DEVICE_PAIRED_EVENT_PREFIX)).be.false();
  });
});

describe('attribution', () => {
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

describe('a push an older app still reads (agenda.wire.1)', () => {
  /** A PINNED copy of the push-kind enum an installed service worker holds: no `agenda`, and it never will. */
  const OLD_PUSH_KINDS = z.enum(['attention', 'question', 'failed', 'completed', 'device-paired']);

  const sent = [
    ['a notice ping', pingNotificationPayload('session-1', item, snapshot)],
    ['a deadline push', deadlineNotificationPayload('session-1', item, snapshot, AT)],
    ['a stop push', stoppedNotificationPayload('session-1', 'Release agent', [item], snapshot)],
  ] as const;

  it.each(sent)('should keep the kind of %s inside the older enum', (_name, payload) => {
    // Act
    const actual = OLD_PUSH_KINDS.safeParse(payload.kind);

    // Assert
    should(actual.success).be.true();
    should(payload.kind).equal('attention');
  });

  it.each(sent)('should keep the tag and the link of %s on the older spelling', (_name, payload) => {
    // Assert
    should(payload.tag).equal('attention-session-1');
    should(payload.url).startWith('/session/session-1?attention=');
    should(payload.url).not.containEql('agenda');
  });

  it('should still accept the later kind in the current schema, so a newer sender is not refused', () => {
    // Assert
    should(
      PushNotificationPayloadSchema.safeParse({
        ...pingNotificationPayload('session-1', item, snapshot),
        kind: 'agenda',
      }).success,
    ).be.true();
    should(OLD_PUSH_KINDS.safeParse('agenda').success).be.false();
  });
});

describe('notification key spellings', () => {
  it('should read an attention key and an agenda key as the same key', () => {
    // Arrange / Act / Assert
    should(normalizedNotificationKey('attention:s:A1:ping')).equal('agenda:s:A1:ping');
    should(normalizedNotificationKey('agenda:s:A1:ping')).equal('agenda:s:A1:ping');
    should(normalizedNotificationKey('direct:abc')).equal('direct:abc');
  });

  it('should spell an agenda key the way a daemon before the rename wrote it', () => {
    // Arrange / Act / Assert
    should(legacyNotificationKey('agenda:s:A1:ping')).equal('attention:s:A1:ping');
    should(legacyNotificationKey('attention:s:A1:ping')).equal('attention:s:A1:ping');
    should(legacyNotificationKey('direct:abc')).equal('direct:abc');
  });
});
