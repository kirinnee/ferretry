import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaActionRequestSchema,
  type AgendaAsk,
  AgendaItemSchema,
  agendaAnswerProblems,
} from '../../../../daemon/lib/protocol/agenda.ts';
import {
  AGENDA_ANSWER_TEXT_CHARS,
  AGENDA_ANSWER_TEXT_CHARS_OF_THREE,
  AGENDA_KIND_LABELS,
  agendaAnswerText,
  agendaCanDiscuss,
  agendaCardAnswers,
  agendaCardKind,
  agendaInDiscussion,
  agendaKindLabel,
  agendaTitle,
  answerInDirection,
  askForKind,
  clipAtWord,
  DISCUSS_LABEL,
  defaultAgendaAnswers,
  hasOwnTitle,
  isYesNoAsk,
  kindOfAsk,
  NOTHING_TO_TRY_PREFIX,
  nothingToTryLine,
  unswipedChoices,
  YES_NO_ORDER,
  yesNoOrder,
} from '../../../../daemon/lib/protocol/agenda-card.ts';

const AT = '2026-10-29T09:00:00.000Z';

const item = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Should I keep the work login alive by renewing it every 30 minutes?',
  why: 'The login expires during long runs.',
  waitingSince: AT,
  howToResolve: 'Answer this item on the agenda board.',
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Olivier',
} as const;

const choice = (...labels: string[]): AgendaAsk => ({
  kind: 'multiple-choice',
  options: labels.map(label => ({ label })),
});

/** The answers as `direction:label`, left · up · right. */
const layout = (answers: readonly { direction: string; label: string }[]): string[] =>
  answers.map(each => `${each.direction}:${each.label}`);

describe('attention card', () => {
  describe('kinds', () => {
    it('reads the kind an old item meant from its ask', () => {
      should(kindOfAsk(undefined)).equal('info');
      should(kindOfAsk({ kind: 'permission' })).equal('permission');
      should(kindOfAsk(choice('Ship', 'Wait'))).equal('choice');
      should(kindOfAsk(choice('yes', 'NO'))).equal('yesno');
      should(kindOfAsk({ kind: 'answer-review' })).equal('review');
      should(kindOfAsk({ kind: 'open-question' })).equal('reply');
      should(kindOfAsk({ kind: 'task' })).equal('task');
    });

    it('prefers the kind an item was raised with', () => {
      should(agendaCardKind({ kind: 'info', ask: { kind: 'task' } })).equal('info');
    });

    it('tells a yes-or-no choice from any other two options', () => {
      should(isYesNoAsk(choice('Yes', 'No'))).be.true();
      should(isYesNoAsk(choice('Yes', 'Later'))).be.false();
      should(isYesNoAsk(choice('Yes', 'No', 'Maybe'))).be.false();
    });

    it('raises each kind with the ask the daemon already answers', () => {
      should(askForKind('yesno')).eql(choice('Yes', 'No'));
      should(askForKind('info')).be.undefined();
      should(askForKind('choice', [{ label: 'A' }, { label: 'B' }])).eql(choice('A', 'B'));
      should(askForKind('reply')).eql({ kind: 'open-question' });
      should(askForKind('input')).be.undefined();
    });
  });

  describe('default answers', () => {
    it('puts one Mark as done right on a task, with an optional up', () => {
      should(layout(defaultAgendaAnswers('task', { kind: 'task' }))).eql(['right:Mark as done']);
      const withSkip = defaultAgendaAnswers('task', { kind: 'task' }, undefined, { label: 'Skip' });
      should(layout(withSkip)).eql(['up:Skip', 'right:Mark as done']);
      should(answerInDirection(withSkip, 'up')?.does).equal('dismiss');
    });

    it('puts No left and Yes right on a yes-or-no card', () => {
      const answers = defaultAgendaAnswers('yesno', choice('Yes', 'No'));
      should(layout(answers)).eql(['left:No', 'right:Yes']);
      should(answers.every(each => each.does === 'choose')).be.true();
    });

    it('puts Deny left and Approve right on a permission, with an optional Always allow up', () => {
      const answers = defaultAgendaAnswers('permission', { kind: 'permission' }, undefined, {
        label: 'Always allow',
      });
      should(layout(answers)).eql(['left:Deny', 'up:Always allow', 'right:Approve']);
      should(answers.map(each => each.does)).eql(['reject', 'approve', 'approve']);
    });

    it('puts the recommended option in the middle and the other left on a two-way choice', () => {
      should(layout(defaultAgendaAnswers('choice', choice('Ship', 'Wait'), 'Wait'))).eql(['left:Ship', 'up:Wait']);
    });

    it('lays a three-way choice out as ←B ↑recommended →C', () => {
      should(layout(defaultAgendaAnswers('choice', choice('A', 'B', 'C'), 'A'))).eql(['left:B', 'up:A', 'right:C']);
    });

    it('recommends the first option when the ferret recommends none', () => {
      should(answerInDirection(defaultAgendaAnswers('choice', choice('A', 'B')), 'up')?.label).equal('A');
    });

    it('puts Request changes left and Approve right on a review', () => {
      should(layout(defaultAgendaAnswers('review', { kind: 'answer-review' }))).eql([
        'left:Request changes',
        'right:Approve',
      ]);
    });

    it('gives info one answer, Got it, on the right, and a text-only ask none', () => {
      should(layout(defaultAgendaAnswers('info', undefined))).eql(['right:Got it']);
      should(defaultAgendaAnswers('reply', { kind: 'open-question' })).eql([]);
      should(defaultAgendaAnswers('input', undefined)).eql([]);
    });
  });

  describe('one meaning for every swipe', () => {
    it('points a row of options in the options list’s order, wherever the recommendation sits', () => {
      const three = { ...item, ask: choice('Pause', 'Switch', 'Warn'), recommendation: { decision: 'Warn' } };
      should(layout(agendaCardAnswers(three))).eql(['left:Pause', 'up:Switch', 'right:Warn']);
      should(layout(agendaCardAnswers({ ...item, ask: choice('Ship') }))).eql(['up:Ship']);
      const asked = {
        ...item,
        ask: choice('Monday', 'Friday'),
        answers: [
          { direction: 'up' as const, does: 'choose' as const, label: 'Friday' },
          { direction: 'left' as const, does: 'choose' as const, label: 'Monday' },
        ],
      };
      should(layout(agendaCardAnswers(asked))).eql(['left:Monday', 'right:Friday']);
    });

    it('puts No ← and Yes → whichever order the ferret listed them in, on a yes-or-no or a two-way choice', () => {
      for (const kind of ['yesno', 'choice'] as const) {
        should(layout(agendaCardAnswers({ ...item, kind, ask: choice('Yes', 'No') }))).eql(['left:No', 'right:Yes']);
        should(layout(agendaCardAnswers({ ...item, kind, ask: choice('No', 'Yes') }))).eql(['left:No', 'right:Yes']);
      }
      // An old item with no kind, its options in either case, and one recommending Yes (kept on ↑ before the rule).
      should(layout(agendaCardAnswers({ ...item, ask: choice('yes', 'NO') }))).eql(['left:NO', 'right:yes']);
      const recommended = {
        ...item,
        kind: 'choice' as const,
        ask: choice('No', 'Yes'),
        recommendation: { decision: 'Yes' },
      };
      should(layout(agendaCardAnswers(recommended))).eql(['left:No', 'right:Yes']);
      // Answers the ferret pointed itself are re-pointed too: the order never depends on how they were written.
      const pointed = {
        ...item,
        ask: choice('Yes', 'No'),
        answers: [
          { direction: 'left' as const, does: 'choose' as const, label: 'Yes' },
          { direction: 'right' as const, does: 'choose' as const, label: 'No' },
        ],
      };
      should(layout(agendaCardAnswers(pointed))).eql(['left:No', 'right:Yes']);
    });

    it('leaves a row that is not exactly Yes and No to the options list’s order', () => {
      should(layout(agendaCardAnswers({ ...item, ask: choice('Yes', 'No', 'Later') }))).eql([
        'left:Yes',
        'up:No',
        'right:Later',
      ]);
      should(layout(agendaCardAnswers({ ...item, ask: choice('Yes', 'Later') }))).eql(['left:Yes', 'right:Later']);
    });

    it('orders any list of Yes and No as No, Yes (yesNoOrder), and leaves any other list alone', () => {
      should(YES_NO_ORDER).eql(['No', 'Yes']);
      should(yesNoOrder(['Yes', 'No'], label => label)).eql(['No', 'Yes']);
      should(yesNoOrder(['No', 'Yes'], label => label)).eql(['No', 'Yes']);
      should(yesNoOrder([' YES ', 'no'], label => label)).eql(['no', ' YES ']);
      should(yesNoOrder(['Yes', 'Later'], label => label)).eql(['Yes', 'Later']);
      should(yesNoOrder(['Yes', 'No', 'Maybe'], label => label)).eql(['Yes', 'No', 'Maybe']);
      should(yesNoOrder([], (label: string) => label)).eql([]);
    });

    it('leaves answers that are not options where the card put them', () => {
      const permission = { ...item, ask: { kind: 'permission' as const } };
      should(layout(agendaCardAnswers(permission))).eql(layout(defaultAgendaAnswers('permission', permission.ask)));
    });
  });

  describe('old items', () => {
    it('reads an item from before cards with no parse failure and derived answers', () => {
      const old = AgendaItemSchema.parse({ ...item, ask: choice('Renew', 'Leave it', 'Ask me each time') });
      should(old.title).be.undefined();
      should(agendaCardKind(old)).equal('choice');
      // A row of options reads in the options list's order: the first ←, the second ↑, the third →.
      should(layout(agendaCardAnswers(old))).eql(['left:Renew', 'up:Leave it', 'right:Ask me each time']);
    });

    it('keeps the old brief recommendation on the row, in its place in the list', () => {
      const old = AgendaItemSchema.parse({
        ...item,
        ask: choice('Renew', 'Leave it'),
        recommendation: { decision: 'Leave it' },
      });
      should(answerInDirection(agendaCardAnswers(old), 'right')?.label).equal('Leave it');
    });

    it('offers an old choice past three options as buttons, not swipes', () => {
      const old = { ...item, ask: choice('A', 'B', 'C', 'D', 'E') };
      should(agendaCardAnswers(old)).have.length(3);
      should(unswipedChoices(old).map(option => option.label)).eql(['D', 'E']);
    });

    it('titles an item with no title by the start of its ask, cut at a word', () => {
      should(agendaTitle(item)).equal('Should I keep the work login alive by…');
      should(agendaTitle(item).length).be.belowOrEqual(40);
      should(hasOwnTitle(item)).be.false();
      should(agendaTitle({ ...item, title: 'Work login renewal' })).equal('Work login renewal');
    });
  });

  describe('validation', () => {
    it('keeps the answers an item was raised with, a row of options pointed in the options list’s order', () => {
      const raised = AgendaItemSchema.parse({
        ...item,
        title: 'Work login renewal',
        kind: 'yesno',
        ask: choice('Yes', 'No'),
        answers: [
          { direction: 'right', does: 'choose', label: 'Yes' },
          { direction: 'left', does: 'choose', label: 'No' },
        ],
      });
      should(layout(agendaCardAnswers(raised))).eql(['left:No', 'right:Yes']);
    });

    it('refuses a stored item whose answers do not fit its ask, naming the answer', () => {
      const parsed = AgendaItemSchema.safeParse({
        ...item,
        ask: { kind: 'task' },
        answers: [{ direction: 'right', does: 'approve', label: 'Allow' }],
      });
      should(parsed.success).be.false();
      should(parsed.error?.issues[0]?.path).eql(['answers', '0', 'does']);
    });

    it('refuses two answers in one direction', () => {
      const problems = agendaAnswerProblems(
        [
          { direction: 'right', does: 'done', label: 'Done' },
          { direction: 'right', does: 'dismiss', label: 'Skip' },
        ],
        { kind: 'task' },
      );
      should(problems.map(([, message]) => message).join(' ')).match(/its own direction/);
    });

    it('refuses an effect the ask cannot take', () => {
      const problems = agendaAnswerProblems([{ direction: 'right', does: 'approve', label: 'Allow' }], {
        kind: 'task',
      });
      should(problems[0]?.[1]).match(/does not answer a task/);
    });

    it('refuses a choose answer that names no option', () => {
      const problems = agendaAnswerProblems(
        [{ direction: 'right', does: 'choose', label: 'Maybe' }],
        choice('Yes', 'No'),
      );
      should(problems[0]?.[1]).match(/one of the ask options/);
    });

    it('refuses a raise with more than three answers', () => {
      const parsed = AgendaActionRequestSchema.safeParse({
        action: 'add',
        title: 'Pick a plan',
        subject: 'Which plan should I build?',
        why: 'Which plan should I build?',
        howToResolve: 'Answer on the board.',
        ask: choice('A', 'B', 'C', 'D'),
        answers: [
          { direction: 'right', does: 'choose', label: 'A' },
          { direction: 'up', does: 'choose', label: 'B' },
          { direction: 'left', does: 'choose', label: 'C' },
          { direction: 'left', does: 'choose', label: 'D' },
        ],
      });
      should(parsed.success).be.false();
    });

    it('accepts a raise with a title, a kind and its default answers', () => {
      const ask = askForKind('permission');
      const parsed = AgendaActionRequestSchema.safeParse({
        action: 'add',
        title: 'Deploy the website',
        kind: 'permission',
        subject: 'May I deploy the new pricing page to the live website now?',
        why: 'It is reviewed and tested.',
        howToResolve: 'Answer on the board.',
        ask,
        answers: defaultAgendaAnswers('permission', ask),
      });
      should(parsed.success).be.true();
    });

    it('refuses a title longer than a line can hold', () => {
      const parsed = AgendaActionRequestSchema.safeParse({
        action: 'add',
        title: 'x'.repeat(61),
        subject: 'Anything',
        why: 'Anything',
        howToResolve: 'Answer on the board.',
      });
      should(parsed.success).be.false();
    });
  });

  it('clips at a word with an ellipsis', () => {
    should(clipAtWord('one two three four', 10)).equal('one two…');
    should(clipAtWord('short', 10)).equal('short');
  });

  describe('what an answer’s button says', () => {
    // The owner's case: options with descriptions once drew "← A | → B" — letters that mean nothing once the ask is
    // off screen.
    const described = {
      ...item,
      ask: {
        kind: 'multiple-choice' as const,
        options: [
          { label: 'No', description: 'Keep counting every snoozed item, as today' },
          { label: 'Only blockers', description: 'Count a snoozed item only once a blocker wakes it' },
        ],
      },
    };

    it('is each described option’s short label; the answer it sends is the label, its description kept beside it', () => {
      const answers = agendaCardAnswers(described);
      should(layout(answers)).eql(['left:No', 'right:Only blockers']);
      should(answers.map(each => agendaAnswerText(each.label))).eql(['No', 'Only blockers']);
      should(answers.map(each => each.description)).eql([
        'Keep counting every snoozed item, as today',
        'Count a snoozed item only once a blocker wakes it',
      ]);
    });

    it('is cut at a word only when very long, and is never empty', () => {
      should(agendaAnswerText('Needs a different approach')).equal('Needs a different…');
      should(agendaAnswerText('Needs a different approach').length).be.belowOrEqual(AGENDA_ANSWER_TEXT_CHARS);
      should(agendaAnswerText('  Ship   it ')).equal('Ship it');
      should(agendaAnswerText('Supercalifragilisticexpialidocious')).equal('Supercalifragilisticexp…');
      should(agendaAnswerText('.'.repeat(40))).not.equal('');
      should(agendaAnswerText('.'.repeat(40))).not.equal('…');
    });

    it('is cut sooner on a row of three, where each button has a third of a phone, and at a word all the same', () => {
      should(agendaAnswerText('Lock the session row', 3)).equal('Lock the session row');
      should(agendaAnswerText('Lock the whole session row', 3)).equal('Lock the whole…');
      should(agendaAnswerText('Lock the whole session row', 2)).equal('Lock the whole session…');
      should(agendaAnswerText('Lock the whole session row', 3).length).be.belowOrEqual(
        AGENDA_ANSWER_TEXT_CHARS_OF_THREE,
      );
      should(agendaAnswerText('Supercalifragilisticexpialidocious', 3)).equal('Supercalifragilisti…');
    });

    it('reads Markdown in a label as plain words, before it is cut, so every surface says the same words', () => {
      should(agendaAnswerText('**Ship** it')).equal('Ship it');
      should(agendaAnswerText('`Wait`', 3)).equal('Wait');
      should(agendaAnswerText('[Spec](https://example.test/spec)')).equal('Spec');
      should(agendaAnswerText('**Lock** the whole session row')).equal('Lock the whole session…');
      should(agendaAnswerText('**Lock** the whole session row', 3)).equal('Lock the whole…');
      should(agendaAnswerText('****')).equal('****');
    });
  });
});

describe('Discuss', () => {
  it('is offered only on an item a ferret raised, under one fixed label', () => {
    should(DISCUSS_LABEL).equal('Discuss');
    should(agendaCanDiscuss(item)).be.true();
    should(agendaCanDiscuss({ raisedBy: 'human' })).be.false();
    should(agendaCanDiscuss({ raisedBy: 'daemon' })).be.false();
  });

  it('reads an item as in discussion only while the ferret is waited on for a discussion', () => {
    should(agendaInDiscussion({ waitingOn: 'ferret', waitingFor: 'discussion' })).be.true();
    should(agendaInDiscussion({ waitingOn: 'ferret', waitingFor: 'info' })).be.false();
    should(agendaInDiscussion({ waitingOn: 'ferret' })).be.false();
    should(agendaInDiscussion({})).be.false();
  });
});

describe('the kind chip words', () => {
  it('names every kind in plain words for what the owner does', () => {
    should(AGENDA_KIND_LABELS).eql({
      reply: 'Question',
      choice: 'Decision',
      yesno: 'Decision',
      task: 'To do',
      permission: 'Approve',
      info: 'FYI',
      review: 'Review',
      form: 'Fill in',
      input: 'Type in',
    });
  });

  it('reads the word from the raised kind, else from the ask an old item carries', () => {
    should(agendaKindLabel({ kind: 'permission' })).equal('Approve');
    should(agendaKindLabel({ ask: { kind: 'open-question' } })).equal('Question');
    should(agendaKindLabel({ ask: { kind: 'task' } })).equal('To do');
    should(agendaKindLabel({})).equal('FYI');
  });
});

describe('nothingToTryLine', () => {
  it('reads the daemon’s one line for a card closed with nothing to try, and nothing else', () => {
    should(nothingToTryLine('&F12: Nothing to try: its PRs change only docs and tests')).equal(
      '&F12: Nothing to try: its PRs change only docs and tests',
    );
    should(nothingToTryLine(undefined)).be.undefined();
    should(nothingToTryLine('&F12 is at To test: Done or Not good')).be.undefined();
    should(nothingToTryLine('Nothing to try: no card named')).be.undefined();
    should(nothingToTryLine('&F12: Nothing to try: ')).be.undefined();
    should(nothingToTryLine(`${NOTHING_TO_TRY_PREFIX}x`)).be.undefined();
  });
});
