import { describe, it } from 'bun:test';
import {
  type AttentionItem,
  AttentionItemSchema,
  AttentionSnapshotSchema,
  type ResolvedAttentionItem,
  ResolvedAttentionItemSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  boardReplyMessage,
  conversationResponse,
  conversationTurn,
  referencedAttention,
  responseWords,
  sessionAttentionSummary,
} from '../../../src/lib/attention/conversation.ts';

const AT = '2026-10-23T10:00:00.000Z';

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return AttentionItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}?`,
    why: 'Blocked on the owner.',
    waitingSince: AT,
    howToResolve: 'Answer it.',
    raisedBy: 'agent',
    raisedBySession: 'session-1',
    raisedByName: 'Ada',
    ...overrides,
  });
}

function closed(base: AttentionItem, resolution: Record<string, unknown>): ResolvedAttentionItem {
  return ResolvedAttentionItemSchema.parse({
    ...base,
    resolvedAt: AT,
    resolutionNote: null,
    disposition: 'done',
    resolvedBy: 'human',
    resolvedBySession: null,
    resolvedByName: null,
    ...resolution,
  });
}

const CHOICE = item('A2', {
  subject: 'Rebase onto main now?',
  ask: { kind: 'multiple-choice', options: [{ label: 'Rebase now' }, { label: 'Wait' }] },
});
const OPEN = item('A3', { subject: 'Which region?', ask: { kind: 'open-question' } });
const PERMISSION = item('A4', { subject: 'Deploy?', ask: { kind: 'permission' } });
const PLAIN = item('A5', { subject: 'Look at the flaky test' });

describe('Attention in a conversation', () => {
  it('should find only open items referenced with the grammar’s own boundaries', () => {
    // Arrange
    const open = [CHOICE, OPEN, PERMISSION];

    // Act
    const found = referencedAttention('(!A3) and !A2, again !A3.', open);
    const prose = referencedAttention('wow!A3 and !a2 and !A30 and !A9', open);

    // Assert
    should(found.map(each => each.id)).deepEqual(['A2', 'A3']);
    should(prose).deepEqual([]);
  });

  it('should say every kind of answer in words', () => {
    // Arrange / Act
    const words = [
      responseWords({ kind: 'permission', decision: 'approve' }),
      responseWords({ kind: 'permission', decision: 'reject' }),
      responseWords({ kind: 'multiple-choice', choice: 'Wait' }),
      responseWords({ kind: 'answer-review', verdict: 'good' }),
      responseWords({ kind: 'answer-review', verdict: 'clarify', clarification: 'Which file?' }),
      responseWords({ kind: 'open-question', answer: 'eu-west-1' }),
    ];

    // Assert
    should(words).deepEqual([
      'Approved.',
      'Rejected.',
      'Wait',
      'Your answer is good.',
      'Please clarify: Which file?',
      'eu-west-1',
    ]);
  });

  it('should tell the ferret every closing: an answer, a reply in words, a bare done and a dismissal', () => {
    // Arrange
    const answered = closed(CHOICE, { response: { kind: 'multiple-choice', choice: 'Wait' } });
    const answeredWithNote = closed(OPEN, {
      response: { kind: 'open-question', answer: 'eu-west-1' },
      resolutionNote: 'cheapest',
    });
    const replied = closed(PERMISSION, { resolutionNote: 'Only after 6pm' });
    const bareDone = closed(PLAIN, {});
    const dismissed = closed(PLAIN, { disposition: 'dismissed', resolutionNote: 'No longer needed' });
    const bareDismiss = closed(PLAIN, { disposition: 'dismissed' });

    // Act / Assert
    should(boardReplyMessage(answered)).equal('[answer to !A2 «Rebase onto main now?»] Wait');
    should(boardReplyMessage(answeredWithNote)).equal('[answer to !A3 «Which region?»] eu-west-1\n\nNote: cheapest');
    should(boardReplyMessage(replied)).equal('[answer to !A4 «Deploy?»] Only after 6pm');
    should(boardReplyMessage(bareDone)).equal('[done !A5 «Look at the flaky test»] The owner marked this done.');
    should(boardReplyMessage(dismissed)).equal('[dismissed !A5 «Look at the flaky test»] No longer needed');
    should(boardReplyMessage(bareDismiss)).equal(
      '[dismissed !A5 «Look at the flaky test»] The owner dismissed this without an answer.',
    );
  });

  it('should quote a long ask only so far', () => {
    // Arrange
    const long = closed(item('A6', { subject: 'x'.repeat(200) }), { resolutionNote: 'ok' });

    // Act
    const message = boardReplyMessage(long);

    // Assert
    should(message).startWith(`[answer to !A6 «${'x'.repeat(120)}…»]`);
  });

  it('should prefix a message that references open items and answer them', () => {
    // Arrange / Act
    const turn = conversationTurn('!A3 eu-west-1, and !A2 Wait', [CHOICE, OPEN], 'fy');

    // Assert
    should(turn.message).equal(
      '[answer to !A2 «Rebase onto main now?», !A3 «Which region?»] !A3 eu-west-1, and !A2 Wait',
    );
    should(turn.answers.map(each => each.id)).deepEqual(['A2', 'A3']);
  });

  it('should tell the ferret which items are open, without resolving any, for a plain message', () => {
    // Arrange / Act
    const turn = conversationTurn('How is it going?', [CHOICE, OPEN], 'fy');
    const empty = conversationTurn('How is it going?', [], 'fy');

    // Assert
    should(turn.message).equal(
      'How is it going?\n\n[open attention: !A2 «Rebase onto main now?»; !A3 «Which region?» — if this message settles one, resolve it with `fy attention done <id>`]',
    );
    should(turn.answers).deepEqual([]);
    should(empty).deepEqual({ message: 'How is it going?', answers: [] });
  });

  it('should leave a harness prompt out of the footer, while a reference still answers it', () => {
    // Arrange
    const harness = item('A6', {
      source: 'question',
      sourceRef: 'toolu_1',
      subject: 'Which region first?',
      ask: { kind: 'open-question' },
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
    } as Partial<AttentionItem>);

    // Act
    const alone = conversationTurn('How is it going?', [harness], 'fy');
    const mixed = conversationTurn('How is it going?', [harness, OPEN], 'fy');
    const answered = conversationTurn('!A6 eu', [harness], 'fy');

    // Assert
    should(alone).deepEqual({ message: 'How is it going?', answers: [] });
    should(mixed.message).endWith(
      '[open attention: !A3 «Which region?» — if this message settles one, resolve it with `fy attention done <id>`]',
    );
    should(answered.answers.map(each => each.id)).deepEqual(['A6']);
  });

  it('should take a chat answer only in the forms its ask accepts', () => {
    // Arrange / Act
    const open = conversationResponse(OPEN, '!A3 eu-west-1');
    const choice = conversationResponse(CHOICE, '!A2  rebase NOW ');
    const notAChoice = conversationResponse(CHOICE, '!A2 rebase it tomorrow');
    const permission = conversationResponse(PERMISSION, '!A4 yes');
    const plain = conversationResponse(PLAIN, '!A5 done');
    const blank = conversationResponse(OPEN, '   ');

    // Assert
    should(open).deepEqual({ kind: 'open-question', answer: 'eu-west-1' });
    should(choice).deepEqual({ kind: 'multiple-choice', choice: 'Rebase now' });
    should(notAChoice).be.undefined();
    should(permission).be.undefined();
    should(plain).be.undefined();
    should(blank).be.undefined();
  });

  it('should summarise a board for the session list: count, oldest, its ask and the newest raise', () => {
    // Arrange
    const later = item('A9', { subject: 'Later ask', waitingSince: '2026-10-23T12:00:00.000Z' });
    const snapshot = AttentionSnapshotSchema.parse({
      v: 1,
      sessionId: 'session-1',
      items: [OPEN, later],
      resolved: [],
      count: 2,
      parseErrors: 0,
      updatedAt: AT,
    });
    const empty = AttentionSnapshotSchema.parse({ ...snapshot, items: [], count: 0 });

    // Act / Assert
    should(sessionAttentionSummary(snapshot)).deepEqual({
      open: 2,
      first: 'A3',
      ask: 'Which region?',
      latestAt: '2026-10-23T12:00:00.000Z',
    });
    should(sessionAttentionSummary(empty)).be.undefined();
  });
});
