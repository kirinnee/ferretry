import { describe, it } from 'bun:test';
import {
  type AgendaItem,
  AgendaItemSchema,
  AgendaSnapshotSchema,
  type ResolvedAgendaItem,
  ResolvedAgendaItemSchema,
} from '@ferretry/protocol';
import should from 'should';
import {
  boardReplyMessage,
  conversationTurn,
  discussMessage,
  needsInfoMessage,
  referencedAgenda,
  responseWords,
  sessionAgendaSummary,
} from '../../../src/lib/agenda/conversation.ts';

const AT = '2026-10-23T10:00:00.000Z';

function item(id: string, overrides: Partial<AgendaItem> = {}): AgendaItem {
  return AgendaItemSchema.parse({
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

function closed(base: AgendaItem, resolution: Record<string, unknown>): ResolvedAgendaItem {
  return ResolvedAgendaItemSchema.parse({
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
    const found = referencedAgenda('(!A3) and !A2, again !A3.', open);
    const prose = referencedAgenda('wow!A3 and !a2 and !A30 and !A9', open);

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
    should(boardReplyMessage(answeredWithNote)).equal('[answer to !A3 «Which region?»] eu-west-1 · note: cheapest');
    should(boardReplyMessage(replied)).equal('[answer to !A4 «Deploy?»] Done · note: Only after 6pm');
    should(boardReplyMessage(bareDone)).equal('[done !A5 «Look at the flaky test»] The owner marked this done.');
    should(boardReplyMessage(dismissed)).equal('[dismissed !A5 «Look at the flaky test»] Not needed: No longer needed');
    should(boardReplyMessage(bareDismiss)).equal(
      '[dismissed !A5 «Look at the flaky test»] Not needed — the owner dismissed this without a reason.',
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
      chooseNote: '[answer to !A2 «Rebase onto main now?»] Rebase now · note: after lunch',
      approve: '[answer to !A4 «Deploy?»] Approved.',
      approveNote: '[answer to !A4 «Deploy?»] Approved. · note: only for this repo',
      reject: '[answer to !A4 «Deploy?»] Rejected.',
      rejectNote: '[answer to !A4 «Deploy?»] Rejected. · note: use the staging account',
      good: '[answer to !A6 «Is the summary right?»] Your answer is good.',
      goodNote: '[answer to !A6 «Is the summary right?»] Your answer is good. · note: nice and short',
      done: '[done !A5 «Look at the flaky test»] The owner marked this done.',
      doneNote: '[answer to !A5 «Look at the flaky test»] Done · note: merged it myself',
      dismiss: '[dismissed !A5 «Look at the flaky test»] Not needed — the owner dismissed this without a reason.',
      dismissNote: '[dismissed !A5 «Look at the flaky test»] Not needed: not this week',
      needsInfo: '[needs more info !A5 «Ask A5?»] The owner needs more information.',
      needsInfoNote: '[needs more info !A5 «Ask A5?»] which account?',
    });
  });

  it('should tell an other answer apart from a chosen option, with or without a note', () => {
    // Arrange
    const other = closed(CHOICE, { response: { kind: 'other', answer: 'Neither — rewrite it' } });
    const otherWithNote = closed(CHOICE, {
      response: { kind: 'other', answer: 'Neither — rewrite it' },
      resolutionNote: 'by Friday',
    });
    const otherNoteEqualsWords = closed(CHOICE, {
      response: { kind: 'other', answer: 'Neither' },
      resolutionNote: 'Other answer (none of the options): Neither',
    });

    // Act / Assert
    should(boardReplyMessage(other)).equal(
      '[answer to !A2 «Rebase onto main now?»] Other answer (none of the options): Neither — rewrite it',
    );
    should(boardReplyMessage(otherWithNote)).equal(
      '[answer to !A2 «Rebase onto main now?»] Other answer (none of the options): Neither — rewrite it · note: by Friday',
    );
    should(boardReplyMessage(otherNoteEqualsWords)).equal(
      '[answer to !A2 «Rebase onto main now?»] Other answer (none of the options): Neither',
    );
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
      '[answer to !A4 «Deploy?»] Approved. · note: Always allow — it is the same repo every time',
    );
    should(boardReplyMessage(alwaysBare)).equal('[answer to !A4 «Deploy?»] Approved. · note: Always allow');
    should(boardReplyMessage(skip)).equal(
      '[dismissed !A5 «Look at the flaky test»] Not needed: Skip — the owner of that test is away',
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

  it('should prefix a message that references open items with their titles, and resolve nothing', () => {
    // Arrange
    const titled = item('A7', { title: 'Release window' });

    // Act
    const turn = conversationTurn('!A3 eu-west-1, and !A7 soon', [OPEN, titled]);

    // Assert
    should(turn.message).equal('[re !A3 «Which region?», !A7 «Release window»] !A3 eu-west-1, and !A7 soon');
    should(turn.referenced.map(each => each.id)).deepEqual(['A3', 'A7']);
  });

  it('should name each referenced item once, in board order, however it is repeated', () => {
    // Arrange / Act
    const turn = conversationTurn('!A3 and !A2 and !A3 again', [CHOICE, OPEN]);

    // Assert
    should(turn.message).startWith('[re !A2 «Rebase onto main now?», !A3 «Which region?»] ');
    should(turn.referenced.map(each => each.id)).deepEqual(['A2', 'A3']);
  });

  it('should treat a message about an item already on the ferret’s turn the same way: referenced, nothing resolved', () => {
    // Arrange
    const talking = item('A8', {
      subject: 'Which region?',
      ask: { kind: 'open-question' },
      waitingOn: 'ferret',
      askedAt: AT,
      waitingFor: 'discussion',
    });

    // Act
    const turn = conversationTurn('!A8 eu-west-1 sounds right', [talking]);

    // Assert
    should(turn.message).equal('[re !A8 «Which region?»] !A8 eu-west-1 sounds right');
    should(turn.referenced.map(each => each.id)).deepEqual(['A8']);
  });

  it('should never reference a notice: it is read, not talked about', () => {
    // Arrange
    const notice = item('A9', { notice: true, kind: 'info' });

    // Act
    const turn = conversationTurn('!A9 thanks, and !A3 eu', [notice, OPEN]);

    // Assert
    should(turn.message).startWith('[re !A3 «Which region?»] ');
    should(turn.referenced.map(each => each.id)).deepEqual(['A3']);
    should(conversationTurn('!A9 thanks', [notice])).deepEqual({ message: '!A9 thanks', referenced: [] });
  });

  it('should deliver a plain message exactly as typed, however many items are open, and reference none', () => {
    // Arrange
    const open = [CHOICE, OPEN, PERMISSION, PLAIN, item('A6'), item('A7')];

    // Act
    const turn = conversationTurn('How is it going?', open);
    const empty = conversationTurn('How is it going?', []);

    // Assert
    should(turn).deepEqual({ message: 'How is it going?', referenced: [] });
    should(empty).deepEqual({ message: 'How is it going?', referenced: [] });
  });

  it('should reference a harness prompt the message names, and leave an unreferenced one alone', () => {
    // Arrange
    const harness = item('A6', {
      source: 'question',
      sourceRef: 'toolu_1',
      subject: 'Which region first?',
      ask: { kind: 'open-question' },
      raisedBy: 'daemon',
      raisedBySession: null,
      raisedByName: null,
    } as Partial<AgendaItem>);

    // Act
    const plain = conversationTurn('How is it going?', [harness, OPEN]);
    const named = conversationTurn('!A6 eu', [harness]);

    // Assert
    should(plain).deepEqual({ message: 'How is it going?', referenced: [] });
    should(named.referenced.map(each => each.id)).deepEqual(['A6']);
  });

  it('should summarise a board for the session list: count, oldest, its ask and the newest raise', () => {
    // Arrange
    const later = item('A9', { subject: 'Later ask', waitingSince: '2026-10-23T12:00:00.000Z' });
    const snapshot = AgendaSnapshotSchema.parse({
      v: 1,
      sessionId: 'session-1',
      items: [OPEN, later],
      resolved: [],
      count: 2,
      parseErrors: 0,
      updatedAt: AT,
    });
    const empty = AgendaSnapshotSchema.parse({ ...snapshot, items: [], count: 0 });

    // Act / Assert
    should(sessionAgendaSummary(snapshot)).deepEqual({
      open: 2,
      first: 'A3',
      ask: 'Which region?',
      latestAt: '2026-10-23T12:00:00.000Z',
    });
    should(sessionAgendaSummary(empty)).be.undefined();
  });

  it('should leave notices out of the counts, the first item and the newest raise', () => {
    // Arrange
    const notice = item('A1', { notice: true, kind: 'info', waitingSince: '2026-10-23T13:00:00.000Z' });
    const board = (items: AgendaItem[]) =>
      AgendaSnapshotSchema.parse({
        v: 1,
        sessionId: 'session-1',
        items,
        resolved: [],
        count: items.length,
        parseErrors: 0,
        updatedAt: AT,
      });

    // Act
    const mixed = sessionAgendaSummary(board([notice, OPEN]));
    const onlyNotice = sessionAgendaSummary(board([notice]));

    // Assert
    should(mixed).deepEqual({ open: 1, first: 'A3', ask: 'Which region?', latestAt: AT });
    should(onlyNotice).be.undefined();
  });

  it('should count the items in discussion apart, and open the row to the oldest one still needing the owner', () => {
    // Arrange
    const discussing = item('A2', { waitingOn: 'ferret', askedAt: AT, waitingFor: 'discussion', infoRequests: 1 });
    const asked = item('A6', { waitingOn: 'ferret', askedAt: AT, infoRequests: 1 });
    const board = (items: AgendaItem[]) =>
      AgendaSnapshotSchema.parse({
        v: 1,
        sessionId: 'session-1',
        items,
        resolved: [],
        count: items.length,
        parseErrors: 0,
        updatedAt: AT,
      });

    // Act
    const mixed = sessionAgendaSummary(board([discussing, OPEN, asked]));
    const onlyTalk = sessionAgendaSummary(board([discussing]));

    // Assert — a request for more information still needs the owner's eye; a discussion does not.
    should(mixed).deepEqual({ open: 3, first: 'A3', ask: 'Which region?', latestAt: AT, discussing: 1 });
    should(onlyTalk).deepEqual({ open: 1, first: 'A2', ask: 'Ask A2?', latestAt: AT, discussing: 1 });
  });

  it('should leave a reference inside the text alone once the prefix is built, and take only the open board', () => {
    // Arrange / Act
    const turn = conversationTurn('!A2 why does it need the prod key? and !A99 too', [OPEN]);

    // Assert
    should(turn).deepEqual({
      message: '!A2 why does it need the prod key? and !A99 too',
      referenced: [],
    });
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
  const discussing = (note?: string, overrides: Partial<AgendaItem> = {}) =>
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
      '[discuss !A14 «Release window»] The owner wants to talk this through before answering: I do not understand the premise. Reply in chat to clear it up; then update the item (`ferret agenda edit A14`) or close it if the premise was wrong (`ferret agenda done A14`).',
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
