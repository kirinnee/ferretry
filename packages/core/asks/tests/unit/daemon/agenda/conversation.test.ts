import { describe, it } from 'bun:test';
import should from 'should';
import {
  boardReplyMessage,
  discussMessage,
  isQuietAcknowledgement,
  needsInfoMessage,
  ownerAnswerMessage,
} from '../../../../daemon/lib/agenda/conversation.ts';
import {
  type AgendaItem,
  type AgendaResponse,
  type ResolvedAgendaItem,
} from '../../../../daemon/lib/protocol/agenda.ts';

const AT = '2026-10-26T09:00:00.000Z';

const openItem = (extra: Record<string, unknown> = {}): AgendaItem =>
  ({
    id: 'A3',
    title: 'Pick the region',
    kind: 'reply',
    subject: 'Which region do we deploy to?',
    source: 'agent-raised',
    sourceRef: null,
    why: 'The release waits on the region.',
    howToResolve: 'Answer in words.',
    waitingSince: AT,
    raisedBy: 'agent',
    raisedBySession: 'session',
    raisedByName: 'Morgan',
    ...extra,
  }) as unknown as AgendaItem;

const resolved = (extra: Record<string, unknown> = {}): ResolvedAgendaItem =>
  ({
    ...openItem(),
    resolvedAt: AT,
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    disposition: 'done',
    resolutionNote: '',
    ...extra,
  }) as unknown as ResolvedAgendaItem;

const FIELDS = [
  { id: 'region', type: 'text', label: 'Which region?', name: 'Region' },
  { id: 'size', type: 'text', label: 'Which size?', name: 'Size' },
];

describe('the words of an owner closing an item', () => {
  const cases: readonly (readonly [string, AgendaResponse, string])[] = [
    ['an approval', { kind: 'permission', decision: 'approve' }, 'Approved.'],
    ['a rejection', { kind: 'permission', decision: 'reject' }, 'Rejected.'],
    ['a picked option', { kind: 'multiple-choice', choice: 'eu-west' }, 'eu-west'],
    ['a good review', { kind: 'answer-review', verdict: 'good' }, 'Your answer is good.'],
    [
      'a review asking to clarify',
      { kind: 'answer-review', verdict: 'clarify', clarification: 'Which region exactly?' },
      'Please clarify: Which region exactly?',
    ],
    ['written words', { kind: 'open-question', answer: 'Use eu-west.' }, 'Use eu-west.'],
    [
      'an answer instead of the options',
      { kind: 'other', answer: 'Neither' },
      'Other answer (none of the options): Neither',
    ],
  ];

  for (const [name, response, words] of cases) {
    it(`should tell the ferret ${name} under the ask it answered`, () => {
      // Act
      const message = boardReplyMessage(resolved({ response }));

      // Assert
      should(message).equal(`[answer to !A3 «Which region do we deploy to?»] ${words}`);
    });
  }

  it('should tell a filled-in form as numbered answers, a skipped field marked', () => {
    // Arrange
    const item = resolved({
      fields: FIELDS,
      response: { kind: 'form', answers: [{ id: 'region', picked: 'eu-west' }] },
    });

    // Act
    const message = boardReplyMessage(item);

    // Assert
    should(message).equal('[answer to !A3 «Which region do we deploy to?»] \n1. Region: eu-west\n2. Size: (skipped)');
  });

  it('should put the owner note under their answer', () => {
    // Act
    const message = boardReplyMessage(
      resolved({ response: { kind: 'open-question', answer: 'eu-west' }, resolutionNote: '  and tell the team  ' }),
    );

    // Assert
    should(message).equal('[answer to !A3 «Which region do we deploy to?»] eu-west · note: and tell the team');
  });

  it('should tell a dismissal with or without the reason', () => {
    should(boardReplyMessage(resolved({ disposition: 'dismissed' }))).equal(
      '[dismissed !A3 «Which region do we deploy to?»] Not needed — the owner dismissed this without a reason.',
    );
    should(boardReplyMessage(resolved({ disposition: 'dismissed', resolutionNote: 'Out of scope' }))).equal(
      '[dismissed !A3 «Which region do we deploy to?»] Not needed: Out of scope',
    );
  });

  it('should tell a bare done, and a done with a note as an answer', () => {
    should(boardReplyMessage(resolved())).equal(
      '[done !A3 «Which region do we deploy to?»] The owner marked this done.',
    );
    should(boardReplyMessage(resolved({ resolutionNote: 'Shipped' }))).equal(
      '[answer to !A3 «Which region do we deploy to?»] Done · note: Shipped',
    );
  });
});

describe('a quiet acknowledgement', () => {
  it('should be only a bare done on an info item', () => {
    should(isQuietAcknowledgement(resolved({ kind: 'info' }))).be.true();
    should(isQuietAcknowledgement(resolved({ kind: 'info', resolutionNote: '   ' }))).be.true();
  });

  it('should not be an info item with words, a dismissal, an answer or another kind', () => {
    should(isQuietAcknowledgement(resolved({ kind: 'info', resolutionNote: 'Thanks' }))).be.false();
    should(isQuietAcknowledgement(resolved({ kind: 'info', disposition: 'dismissed' }))).be.false();
    should(
      isQuietAcknowledgement(resolved({ kind: 'info', response: { kind: 'open-question', answer: 'ok' } })),
    ).be.false();
    should(isQuietAcknowledgement(resolved({ kind: 'reply' }))).be.false();
  });
});

describe('the answer that rests an item', () => {
  it('should be told in the same words as an answer that closed it', () => {
    // Arrange
    const item = openItem({
      ownerAnswer: { at: AT, response: { kind: 'multiple-choice', choice: 'eu-west' }, note: ' soon ', request: 1 },
    });

    // Act
    const message = ownerAnswerMessage(item);

    // Assert
    should(message).equal('[answer to !A3 «Which region do we deploy to?»] eu-west · note: soon');
  });

  it('should be nothing when the item carries no answer', () => {
    should(ownerAnswerMessage(openItem())).be.undefined();
  });
});

describe('the requests for more information or a discussion', () => {
  it('should quote the latest needs-info note', () => {
    // Arrange
    const item = openItem({
      history: [
        { kind: 'needs-info', at: AT, note: 'first' },
        { kind: 'needs-info', at: AT, note: '  which account?  ' },
      ],
    });

    // Act
    const message = needsInfoMessage(item);

    // Assert
    should(message).equal('[needs more info !A3 «Which region do we deploy to?»] which account?');
  });

  it('should say the owner needs more information when there is no note', () => {
    should(needsInfoMessage(openItem())).equal(
      '[needs more info !A3 «Which region do we deploy to?»] The owner needs more information.',
    );
  });

  it('should name a discussion by the item title and the binary the ferret runs', () => {
    // Arrange
    const item = openItem({ history: [{ kind: 'discuss', at: AT, note: 'premise is wrong' }] });

    // Act
    const message = discussMessage(item, 'fy');

    // Assert
    should(message).startWith(
      '[discuss !A3 «Pick the region»] The owner wants to talk this through before answering: premise is wrong',
    );
    should(message).containEql('`fy agenda edit A3`');
    should(message).containEql('`fy agenda done A3`');
  });

  it('should say there is no note on a discussion asked for without one', () => {
    should(discussMessage(openItem(), 'fy')).containEql('before answering: no note.');
  });
});
