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
  discussMessage,
  needsInfoMessage,
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
    should(boardReplyMessage(replied)).equal('[answer to !A4 «Deploy?»] Done.\n\nNote: Only after 6pm');
    should(boardReplyMessage(bareDone)).equal('[done !A5 «Look at the flaky test»] The owner marked this done.');
    should(boardReplyMessage(dismissed)).equal('[dismissed !A5 «Look at the flaky test»] No longer needed');
    should(boardReplyMessage(bareDismiss)).equal(
      '[dismissed !A5 «Look at the flaky test»] The owner dismissed this without an answer.',
    );
  });

  it('should deliver the answer AND the owner’s reply for every action, with and without a reply', () => {
    // Arrange
    const asked = (note?: string) =>
      item('A5', {
        waitingOn: 'ferret',
        askedAt: AT,
        infoRequests: 1,
        history: [{ at: AT, kind: 'needs-info', ...(note === undefined ? {} : { note }) }],
      });
    const choose = (note?: string) =>
      closed(CHOICE, {
        response: { kind: 'multiple-choice', choice: 'Rebase now' },
        ...(note === undefined ? {} : { resolutionNote: note }),
      });
    const permission = (decision: 'approve' | 'reject', note?: string) =>
      closed(PERMISSION, {
        response: { kind: 'permission', decision },
        ...(note === undefined ? {} : { resolutionNote: note }),
      });
    const REVIEW = item('A6', { subject: 'Is the summary right?', ask: { kind: 'answer-review' } });
    const review = (note?: string) =>
      closed(REVIEW, {
        response: { kind: 'answer-review', verdict: 'good' },
        ...(note === undefined ? {} : { resolutionNote: note }),
      });
    const done = (note?: string) => closed(PLAIN, note === undefined ? {} : { resolutionNote: note });
    const dismiss = (note?: string) =>
      closed(PLAIN, { disposition: 'dismissed', ...(note === undefined ? {} : { resolutionNote: note }) });

    // Act
    const lines = {
      choose: boardReplyMessage(choose()),
      chooseNote: boardReplyMessage(choose('after lunch')),
      approve: boardReplyMessage(permission('approve')),
      approveNote: boardReplyMessage(permission('approve', 'only for this repo')),
      reject: boardReplyMessage(permission('reject')),
      rejectNote: boardReplyMessage(permission('reject', 'use the staging account')),
      good: boardReplyMessage(review()),
      goodNote: boardReplyMessage(review('nice and short')),
      done: boardReplyMessage(done()),
      doneNote: boardReplyMessage(done('merged it myself')),
      dismiss: boardReplyMessage(dismiss()),
      dismissNote: boardReplyMessage(dismiss('not this week')),
      needsInfo: needsInfoMessage(asked()),
      needsInfoNote: needsInfoMessage(asked('which account?')),
    };

    // Assert
    should(lines).deepEqual({
      choose: '[answer to !A2 «Rebase onto main now?»] Rebase now',
      chooseNote: '[answer to !A2 «Rebase onto main now?»] Rebase now\n\nNote: after lunch',
      approve: '[answer to !A4 «Deploy?»] Approved.',
      approveNote: '[answer to !A4 «Deploy?»] Approved.\n\nNote: only for this repo',
      reject: '[answer to !A4 «Deploy?»] Rejected.',
      rejectNote: '[answer to !A4 «Deploy?»] Rejected.\n\nNote: use the staging account',
      good: '[answer to !A6 «Is the summary right?»] Your answer is good.',
      goodNote: '[answer to !A6 «Is the summary right?»] Your answer is good.\n\nNote: nice and short',
      done: '[done !A5 «Look at the flaky test»] The owner marked this done.',
      doneNote: '[answer to !A5 «Look at the flaky test»] Done.\n\nNote: merged it myself',
      dismiss: '[dismissed !A5 «Look at the flaky test»] The owner dismissed this without an answer.',
      dismissNote: '[dismissed !A5 «Look at the flaky test»] not this week',
      needsInfo: '[needs more info !A5 «Ask A5?»] The owner needs more information.',
      needsInfoNote: '[needs more info !A5 «Ask A5?»] which account?',
    });
  });

  it('should read a non-default answer label as the start of the owner’s reply, after the answer', () => {
    // Arrange — the app words an answer that is not its kind's default as the note's first words:
    // permission ↑ "Always allow" is an approve, task ↑ "Skip" is a dismiss.
    const always = closed(PERMISSION, {
      response: { kind: 'permission', decision: 'approve' },
      resolutionNote: 'Always allow — it is the same repo every time',
    });
    const alwaysBare = closed(PERMISSION, {
      response: { kind: 'permission', decision: 'approve' },
      resolutionNote: 'Always allow',
    });
    const skip = closed(PLAIN, { disposition: 'dismissed', resolutionNote: 'Skip — the owner of that test is away' });

    // Act / Assert
    should(boardReplyMessage(always)).equal(
      '[answer to !A4 «Deploy?»] Approved.\n\nNote: Always allow — it is the same repo every time',
    );
    should(boardReplyMessage(alwaysBare)).equal('[answer to !A4 «Deploy?»] Approved.\n\nNote: Always allow');
    should(boardReplyMessage(skip)).equal(
      '[dismissed !A5 «Look at the flaky test»] Skip — the owner of that test is away',
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
    const turn = conversationTurn('!A3 eu-west-1, and !A2 Wait', [CHOICE, OPEN]);

    // Assert
    should(turn.message).equal(
      '[answer to !A2 «Rebase onto main now?», !A3 «Which region?»] !A3 eu-west-1, and !A2 Wait',
    );
    should(turn.answers.map(each => each.id)).deepEqual(['A2', 'A3']);
  });

  it('should deliver a plain message exactly as typed, however many items are open, and resolve none', () => {
    // Arrange
    const open = [CHOICE, OPEN, PERMISSION, PLAIN, item('A6'), item('A7')];

    // Act
    const turn = conversationTurn('How is it going?', open);
    const empty = conversationTurn('How is it going?', []);

    // Assert
    should(turn).deepEqual({ message: 'How is it going?', answers: [] });
    should(empty).deepEqual({ message: 'How is it going?', answers: [] });
  });

  it('should still answer a harness prompt the message references, and leave an unreferenced one alone', () => {
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
    const plain = conversationTurn('How is it going?', [harness, OPEN]);
    const answered = conversationTurn('!A6 eu', [harness]);

    // Assert
    should(plain).deepEqual({ message: 'How is it going?', answers: [] });
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

describe('needsInfoMessage', () => {
  it('should carry the latest note, or say the owner needs more information without one', () => {
    // Arrange
    const asked = (note?: string) =>
      item('A5', {
        waitingOn: 'ferret',
        askedAt: AT,
        infoRequests: 2,
        history: [
          { at: AT, kind: 'needs-info', note: 'old note' },
          { at: AT, kind: 'updated' },
          { at: AT, kind: 'needs-info', ...(note === undefined ? {} : { note }) },
        ],
      });

    // Act + Assert
    should(needsInfoMessage(asked('Which account?'))).equal('[needs more info !A5 «Ask A5?»] Which account?');
    should(needsInfoMessage(asked())).equal('[needs more info !A5 «Ask A5?»] The owner needs more information.');
    should(needsInfoMessage(item('A5'))).equal('[needs more info !A5 «Ask A5?»] The owner needs more information.');
  });
});

describe('discussMessage', () => {
  const discussing = (note?: string, overrides: Partial<AttentionItem> = {}) =>
    item('A14', {
      waitingOn: 'ferret',
      askedAt: AT,
      waitingFor: 'discussion',
      infoRequests: 1,
      history: [{ at: AT, kind: 'discuss', ...(note === undefined ? {} : { note }) }],
      ...overrides,
    });

  it('should name the item by its title, carry the note and say what to run, with the binary it was given', () => {
    // Arrange
    const titled = discussing('I do not understand the premise', { title: 'Release window' });

    // Act
    const message = discussMessage(titled, 'ferret');

    // Assert
    should(message).equal(
      '[discuss !A14 «Release window»] The owner wants to talk this through before answering: I do not understand the premise. Reply in chat to clear it up; then update the item (`ferret attention edit A14`) or close it if the premise was wrong (`ferret attention done A14`).',
    );
  });

  it('should fall back to the subject and to "no note", and use the latest discuss note', () => {
    // Arrange
    const noNote = discussing();
    const latest = discussing('second', {
      history: [
        { at: AT, kind: 'discuss', note: 'first' },
        { at: AT, kind: 'updated' },
        { at: AT, kind: 'discuss', note: 'second' },
      ],
    });

    // Act + Assert
    should(discussMessage(noNote, 'fy')).startWith(
      '[discuss !A14 «Ask A14?»] The owner wants to talk this through before answering: no note. ',
    );
    should(discussMessage(latest, 'fy')).containEql('before answering: second. ');
  });
});
