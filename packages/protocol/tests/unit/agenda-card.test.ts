import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaActionRequestSchema,
  type AgendaAsk,
  AgendaItemSchema,
  agendaAnswerProblems,
} from '../../src/lib/agenda.ts';
import {
  answerInDirection,
  askForKind,
  agendaCanDiscuss,
  agendaCardAnswers,
  agendaCardKind,
  agendaInDiscussion,
  agendaTitle,
  clipAtWord,
  DISCUSS_LABEL,
  defaultAgendaAnswers,
  hasOwnTitle,
  isYesNoAsk,
  kindOfAsk,
  unswipedChoices,
} from '../../src/lib/agenda-card.ts';

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
    it('puts Done right and Need more info left on a task, with an optional up', () => {
      should(layout(defaultAgendaAnswers('task', { kind: 'task' }))).eql(['left:Need more info', 'right:Done']);
      const withSkip = defaultAgendaAnswers('task', { kind: 'task' }, undefined, { label: 'Skip' });
      should(layout(withSkip)).eql(['left:Need more info', 'up:Skip', 'right:Done']);
      should(answerInDirection(withSkip, 'up')?.does).equal('dismiss');
    });

    it('puts No left and Yes right on a yes-or-no card', () => {
      const answers = defaultAgendaAnswers('yesno', choice('Yes', 'No'));
      should(layout(answers)).eql(['left:No', 'right:Yes']);
      should(answers.every(each => each.does === 'choose')).be.true();
    });

    it('puts Deny left and Allow right on a permission, with an optional Always allow up', () => {
      const answers = defaultAgendaAnswers('permission', { kind: 'permission' }, undefined, {
        label: 'Always allow',
      });
      should(layout(answers)).eql(['left:Deny', 'up:Always allow', 'right:Allow']);
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

    it('puts Needs changes left and Looks good right on a review', () => {
      should(layout(defaultAgendaAnswers('review', { kind: 'answer-review' }))).eql([
        'left:Needs changes',
        'right:Looks good',
      ]);
    });

    it('gives info one answer, Got it, on the right, and a text-only ask none', () => {
      should(layout(defaultAgendaAnswers('info', undefined))).eql(['right:Got it']);
      should(defaultAgendaAnswers('reply', { kind: 'open-question' })).eql([]);
      should(defaultAgendaAnswers('input', undefined)).eql([]);
    });
  });

  describe('old items', () => {
    it('reads an item from before cards with no parse failure and derived answers', () => {
      const old = AgendaItemSchema.parse({ ...item, ask: choice('Renew', 'Leave it', 'Ask me each time') });
      should(old.title).be.undefined();
      should(agendaCardKind(old)).equal('choice');
      should(layout(agendaCardAnswers(old))).eql(['left:Leave it', 'up:Renew', 'right:Ask me each time']);
    });

    it('takes the old brief recommendation as the middle answer', () => {
      const old = AgendaItemSchema.parse({
        ...item,
        ask: choice('Renew', 'Leave it'),
        recommendation: { decision: 'Leave it' },
      });
      should(answerInDirection(agendaCardAnswers(old), 'up')?.label).equal('Leave it');
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
    it('keeps the answers an item was raised with, in left · up · right order', () => {
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
