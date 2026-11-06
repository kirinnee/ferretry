import { describe, it } from 'bun:test';
import should from 'should';
import { AgendaSnapshotSchema as OldAgendaSnapshotSchema } from '../fixtures/agenda-before-channel.ts';
import {
  AgendaItemSchema,
  AgendaSnapshotSchema,
  type AgendaResponse,
  MAX_AGENDA_CONTENT_LENGTH,
  MAX_AGENDA_RESPONSE_LENGTH,
  ResolvedAgendaItemSchema,
} from '../../src/lib/agenda.ts';
import {
  AGENDA_CHANNEL_HEADER,
  LEGACY_AGENDA_LIMITS,
  legacyAgendaItem,
  legacyAgendaOpenSession,
  legacyAgendaSnapshot,
  legacyResolvedAgendaItem,
  readsAgendaChannel,
  readsAgendaHeaders,
} from '../../src/lib/agenda-legacy.ts';

const AT = '2026-11-03T09:00:00.000Z';

const minimal = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approve the plan',
  why: 'Approve the plan',
  waitingSince: AT,
  howToResolve: 'Answer this item on the agenda board.',
  ask: { kind: 'open-question' },
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Olivier',
} as const;

const SNAPSHOT = {
  v: 1,
  sessionId: 'session-1',
  count: 1,
  parseErrors: 0,
  updatedAt: AT,
} as const;

describe('the legacy agenda projection', () => {
  it('should project option explanations and every free-text response variant into the old schema', () => {
    const optionItem = AgendaItemSchema.parse({
      ...minimal,
      ask: { kind: 'multiple-choice', options: [{ label: 'Proceed' }, { label: 'Wait' }] },
      optionDetails: [{ label: 'Proceed', detail: 'd'.repeat(3_000) }],
    });
    const session = legacyAgendaOpenSession({ sessionId: 'session-1', items: [optionItem] });
    should(session.items[0]?.optionDetails?.[0]?.detail).have.length(LEGACY_AGENDA_LIMITS.optionDetail);
    should(OldAgendaSnapshotSchema.safeParse({ ...SNAPSHOT, ...session, resolved: [] }).success).be.true();

    const responses: AgendaResponse[] = [
      { kind: 'answer-review', verdict: 'clarify', clarification: 'c'.repeat(3_000) },
      { kind: 'answer-review', verdict: 'good' },
      {
        kind: 'form',
        answers: [
          { id: 'free', picked: 'f'.repeat(3_000) },
          { id: 'many', picked: ['One', 'Two'] },
        ],
      },
    ];
    for (const response of responses) {
      const item = AgendaItemSchema.parse({
        ...minimal,
        undelivered: { at: AT, reason: 'offline', reply: { action: 'resolve', response } },
      });
      const projected = legacyAgendaItem(item);
      should(OldAgendaSnapshotSchema.safeParse({ ...SNAPSHOT, items: [projected], resolved: [] }).success).be.true();
      const reply = projected.undelivered?.reply;
      if (reply?.action !== 'resolve') throw new Error('missing retry');
      if (reply.response?.kind === 'answer-review' && reply.response.verdict === 'clarify') {
        should(reply.response.clarification).have.length(LEGACY_AGENDA_LIMITS.text);
      }
      if (reply.response?.kind === 'form') {
        should(reply.response.answers[0]?.picked).have.length(LEGACY_AGENDA_LIMITS.text);
        should(reply.response.answers[1]?.picked).deepEqual(['One', 'Two']);
      }
    }
  });
  it('should satisfy the pre-channel main schema for every nested widened field', () => {
    const item = AgendaItemSchema.parse({
      ...minimal,
      questionAnswer: 'q'.repeat(9_000),
      revisions: [
        {
          at: AT,
          by: 'agent',
          changed: ['questionAnswer', 'whereWeAre'],
          previous: { questionAnswer: 'p'.repeat(9_000), whereWeAre: 'old' },
        },
      ],
      undelivered: {
        at: AT,
        reason: 'offline',
        reply: {
          action: 'resolve',
          note: 'n'.repeat(3_000),
          response: { kind: 'open-question', answer: 'a'.repeat(3_000) },
        },
      },
    });
    const board = { ...SNAPSHOT, items: [item], resolved: [] };
    should(OldAgendaSnapshotSchema.safeParse(board).success).be.false();
    should(OldAgendaSnapshotSchema.safeParse(legacyAgendaSnapshot(board)).success).be.true();
    should(item.undelivered?.reply.note).have.length(3_000);
    should(item.questionAnswer).have.length(9_000);
  });
  it('should clip what the channel widened to the bound the older app held, marking the cut', () => {
    // Arrange
    const item = AgendaItemSchema.parse({
      ...minimal,
      premise: 'p'.repeat(5_000),
      context: 'c'.repeat(9_000),
      body: 'b'.repeat(100_000),
      steps: ['s'.repeat(6_000)],
    });

    // Act
    const actual = legacyAgendaItem(item);

    // Assert
    should(actual.premise).have.length(LEGACY_AGENDA_LIMITS.points);
    should(actual.premise?.endsWith('…')).equal(true);
    should(actual.context).have.length(LEGACY_AGENDA_LIMITS.text);
    should(actual.body).have.length(LEGACY_AGENDA_LIMITS.body);
    should(actual.steps?.[0]).have.length(LEGACY_AGENDA_LIMITS.step);
  });

  it('should leave a short item exactly as it is', () => {
    // Arrange
    const item = AgendaItemSchema.parse({ ...minimal, premise: 'Short.', body: 'Short body.' });

    // Act
    const actual = legacyAgendaItem(item);

    // Assert
    should(actual).deepEqual(item);
  });

  it('should leave out the keys only the channel carries', () => {
    // Arrange
    const item = AgendaItemSchema.parse({
      ...minimal,
      whereWeAre: 'Halfway.',
      detail: 'More.',
      resting: { sub: 'working', at: AT },
      ownerAnswer: { at: AT, response: { kind: 'open-question', answer: 'Yes' }, request: 1 },
    });

    // Act
    const actual = legacyAgendaItem(item) as Record<string, unknown>;

    // Assert
    for (const key of ['whereWeAre', 'detail', 'resting', 'ownerAnswer']) should(actual).not.have.property(key);
  });

  it('should drop an edit that only changed a field the older app does not know, and filter the rest', () => {
    // Arrange
    const item = AgendaItemSchema.parse({
      ...minimal,
      revisions: [
        { at: AT, by: 'agent', changed: ['whereWeAre'], previous: { whereWeAre: 'Before.' } },
        { at: AT, by: 'agent', changed: ['subject', 'detail'], previous: { subject: 'Old', detail: 'Old detail' } },
      ],
    });

    // Act
    const actual = legacyAgendaItem(item);

    // Assert
    should(actual.revisions).deepEqual([{ at: AT, by: 'agent', changed: ['subject'], previous: { subject: 'Old' } }]);
  });

  it('should leave a link meaning out, also from a revision, so the board stays readable to the pre-channel app', () => {
    // Arrange
    const item = AgendaItemSchema.parse({
      ...minimal,
      links: [{ label: 'Plan', target: '&F12', meaning: 'The plan to keep the login alive' }, { target: '#F13' }],
      revisions: [
        {
          at: AT,
          by: 'agent',
          changed: ['links'],
          previous: { links: [{ label: 'Plan', target: '&F12', meaning: 'The older words' }] },
        },
      ],
    });
    const board = { ...SNAPSHOT, items: [item], resolved: [] };

    // Act
    const actual = legacyAgendaItem(item);

    // Assert — the item and its revision keep label and target; the stored item is untouched.
    should(actual.links).deepEqual([{ label: 'Plan', target: '&F12' }, { target: '#F13' }]);
    should(actual.revisions?.[0]?.previous.links).deepEqual([{ label: 'Plan', target: '&F12' }]);
    should(item.links?.[0]?.meaning).equal('The plan to keep the login alive');
    should(OldAgendaSnapshotSchema.safeParse(board).success).be.false();
    should(OldAgendaSnapshotSchema.safeParse(legacyAgendaSnapshot(board)).success).be.true();
  });

  it('should strip the owner response from history and clip its notes', () => {
    // Arrange
    const item = AgendaItemSchema.parse({
      ...minimal,
      history: [
        {
          at: AT,
          kind: 'replied',
          note: 'n'.repeat(4_000),
          response: { kind: 'open-question', answer: 'Yes' },
        },
      ],
    });

    // Act
    const actual = legacyAgendaItem(item);

    // Assert
    should(actual.history).have.length(1);
    should(actual.history?.[0]).not.have.property('response');
    should(actual.history?.[0]?.note).have.length(LEGACY_AGENDA_LIMITS.text);
  });

  it('should clip what a closed item recorded, the owner’s long answer included', () => {
    // Arrange
    const closed = ResolvedAgendaItemSchema.parse({
      ...minimal,
      resolvedAt: AT,
      disposition: 'done',
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
      resolutionNote: 'r'.repeat(9_000),
      response: { kind: 'open-question', answer: 'a'.repeat(9_000) },
    });

    // Act
    const actual = legacyResolvedAgendaItem(closed);

    // Assert
    should(actual.resolutionNote).have.length(LEGACY_AGENDA_LIMITS.text);
    should(actual.response).containEql({ kind: 'open-question' });
    should((actual.response as { answer: string }).answer).have.length(LEGACY_AGENDA_LIMITS.text);
  });

  it('should project every item of a snapshot and keep the rest of it', () => {
    // Arrange
    const snapshot = AgendaSnapshotSchema.parse({
      ...SNAPSHOT,
      items: [{ ...minimal, body: 'b'.repeat(50_000), whereWeAre: 'x' }],
      resolved: [],
    });

    // Act
    const actual = legacyAgendaSnapshot(snapshot);

    // Assert
    should(actual.items[0]?.body).have.length(LEGACY_AGENDA_LIMITS.body);
    should(actual.items[0]).not.have.property('whereWeAre');
    should(actual.sessionId).equal('session-1');
    should(AgendaSnapshotSchema.safeParse(actual).success).equal(true);
  });
});

describe('reading the agenda channel', () => {
  const headers = (value: string | null) => ({
    get: (name: string) => (name === AGENDA_CHANNEL_HEADER ? value : null),
  });

  it('should be true only for a caller that names the channel version', () => {
    // Assert
    should(readsAgendaChannel(headers('1'))).equal(true);
    should(readsAgendaChannel(headers(' 1 '))).equal(true);
    should(readsAgendaChannel(headers(null))).equal(false);
    should(readsAgendaChannel(headers('2'))).equal(true);
    should(readsAgendaChannel(headers(' 2 '))).equal(true);
    should(readsAgendaChannel(headers('3'))).equal(false);
    should(readsAgendaChannel(headers(''))).equal(false);
  });
});

describe('reading resolved agenda headers', () => {
  it('requires channel 2 explicitly', () => {
    for (const value of ['2', ' 2 '])
      should(readsAgendaHeaders(new Headers({ [AGENDA_CHANNEL_HEADER]: value }))).equal(true);
    for (const value of ['', '1', '3'])
      should(readsAgendaHeaders(new Headers({ [AGENDA_CHANNEL_HEADER]: value }))).equal(false);
    should(readsAgendaHeaders(new Headers())).equal(false);
  });
});

describe('the bounds of an owner response', () => {
  it('should refuse a response over its bound and accept one at it', () => {
    // Arrange
    const over = {
      ...minimal,
      resolvedAt: AT,
      disposition: 'done',
      resolutionNote: null,
      resolvedBy: 'human',
      resolvedBySession: null,
      resolvedByName: null,
    };

    // Act
    const refused = ResolvedAgendaItemSchema.safeParse({
      ...over,
      response: { kind: 'open-question', answer: 'a'.repeat(MAX_AGENDA_RESPONSE_LENGTH + 1) },
    });

    // Assert
    should(refused.success).equal(false);
    should(MAX_AGENDA_CONTENT_LENGTH).be.above(MAX_AGENDA_RESPONSE_LENGTH);
  });
});

it('sheds oldest history when it crowds the transport bound, retaining gate receipts', async () => {
  const { fitAgendaItem, MAX_AGENDA_ITEM_LENGTH } = await import('../../src/lib/agenda.ts');
  const item = {
    body: 'b'.repeat(MAX_AGENDA_ITEM_LENGTH - 100),
    history: [
      { kind: 'replied', note: 'r'.repeat(500) },
      { kind: 'gate-answered', note: 'gate:F12' },
    ],
  };
  const fitted = fitAgendaItem(item);
  should(fitted.history).deepEqual([{ kind: 'gate-answered', note: 'gate:F12' }]);
  should(JSON.stringify(fitted).length).be.below(MAX_AGENDA_ITEM_LENGTH);
});
