import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaCardAnswer } from '../../src/lib/agenda.ts';
import { agendaCardAnswers, agendaShape, isDefaultAnswerLabel } from '../../src/lib/agenda-card.ts';
import {
  AGENDA_NEED_HEADING,
  AGENDA_SHAPE_ERRORS,
  AGENDA_SHAPE_LEADS,
  AGENDA_SHAPE_LINE,
  agendaEditShapeProblems,
  agendaShapeHelp,
  agendaShapeProblems,
} from '../../src/lib/agenda-shape.ts';

const choice = { kind: 'multiple-choice' as const, options: [{ label: 'EU' }, { label: 'US' }] };
const card = (fields: Omit<Parameters<typeof agendaCardAnswers>[0], 'subject'>) => ({ subject: 'x', ...fields });
const labels = (answers: readonly AgendaCardAnswer[]) => answers.map(each => `${each.direction}:${each.label}`);

describe('agendaShape', () => {
  it('should read one shape per kind from the stored fields', () => {
    should(agendaShape({ kind: 'choice', ask: choice })).equal('choice');
    should(agendaShape({ kind: 'yesno', ask: choice })).equal('yesno');
    should(agendaShape({ kind: 'permission', ask: { kind: 'permission' } })).equal('approval');
    should(agendaShape({ kind: 'review', ask: { kind: 'answer-review' } })).equal('review');
    should(agendaShape({ kind: 'reply', ask: { kind: 'open-question' } })).equal('reply');
    should(agendaShape({ kind: 'task', ask: { kind: 'task' }, steps: ['One'] })).equal('todo');
    should(agendaShape({ kind: 'info' })).equal('info');
    should(agendaShape({ notice: true })).equal('info');
    should(agendaShape({ kind: 'input' })).equal('input');
  });

  it('should read several questions, or a question with steps, as the numbered-answers shape', () => {
    const several = [{ question: 'Which region?' }, { question: 'OK to restart?' }];
    should(agendaShape({ ask: { kind: 'open-question' }, questions: several })).equal('answers');
    // An item raised before the rule: several questions each with options, or a choice that also had steps.
    should(
      agendaShape({ ask: { kind: 'open-question' }, questions: several.map(each => ({ ...each, options: [] })) }),
    ).equal('answers');
    should(agendaShape({ kind: 'choice', ask: choice, steps: ['Open it'] })).equal('answers');
    should(agendaShape({ kind: 'review', ask: { kind: 'answer-review' }, steps: ['Try it'] })).equal('answers');
  });

  it('should keep a held configuration change a choice, and an old item with no kind read from its ask', () => {
    should(agendaShape({ ask: choice, confirms: 'machine.yaml' })).equal('choice');
    should(agendaShape({ ask: { kind: 'task' } })).equal('todo');
    should(agendaShape({ ask: { kind: 'open-question' } })).equal('reply');
    should(agendaShape({})).equal('info');
  });
});

describe('agendaCardAnswers by shape', () => {
  it('should give an open question and several questions no buttons, even with answers stored', () => {
    const stored: AgendaCardAnswer[] = [{ direction: 'right', does: 'done', label: 'Done' }];
    should(agendaCardAnswers(card({ kind: 'reply', ask: { kind: 'open-question' }, answers: stored }))).eql([]);
    should(
      agendaCardAnswers(
        card({
          ask: { kind: 'open-question' },
          questions: [
            { question: 'a?', options: [{ label: 'A' }, { label: 'B' }] },
            { question: 'b?', options: [{ label: 'C' }, { label: 'D' }] },
          ],
        }),
      ),
    ).eql([]);
    should(agendaCardAnswers(card({ kind: 'choice', ask: choice, steps: ['Open it'] }))).eql([]);
  });

  it('should give a to-do only Mark as done (and a Skip its ferret added), even when stored with Need more info', () => {
    should(labels(agendaCardAnswers(card({ kind: 'task', ask: { kind: 'task' } })))).eql(['right:Mark as done']);
    const old: AgendaCardAnswer[] = [
      { direction: 'left', does: 'needs-info', label: 'Need more info' },
      { direction: 'up', does: 'dismiss', label: 'Skip' },
      { direction: 'right', does: 'done', label: 'Done' },
    ];
    should(labels(agendaCardAnswers(card({ kind: 'task', ask: { kind: 'task' }, answers: old })))).eql([
      'up:Skip',
      'right:Done',
    ]);
  });

  it('should give info one Got it, approval Approve and Deny, review Approve and Request changes', () => {
    should(labels(agendaCardAnswers(card({ kind: 'info' })))).eql(['right:Got it']);
    should(labels(agendaCardAnswers(card({ kind: 'permission', ask: { kind: 'permission' } })))).eql([
      'left:Deny',
      'right:Approve',
    ]);
    should(labels(agendaCardAnswers(card({ kind: 'review', ask: { kind: 'answer-review' } })))).eql([
      'left:Request changes',
      'right:Approve',
    ]);
    should(labels(agendaCardAnswers(card({ kind: 'choice', ask: choice })))).eql(['left:EU', 'right:US']);
  });

  it('should still read the words an older default answer was stored with as default words', () => {
    should(isDefaultAnswerLabel('approve', 'Allow')).be.true();
    should(isDefaultAnswerLabel('approve', 'Approve')).be.true();
    should(isDefaultAnswerLabel('good', 'Looks good')).be.true();
    should(isDefaultAnswerLabel('clarify', 'Needs changes')).be.true();
    should(isDefaultAnswerLabel('done', 'Mark as done')).be.true();
    should(isDefaultAnswerLabel('done', 'Got it')).be.true();
    should(isDefaultAnswerLabel('approve', 'Always allow')).be.false();
    should(isDefaultAnswerLabel('choose', 'Approve')).be.false();
  });
});

describe('agendaShapeProblems', () => {
  const several = [{ question: 'Which region?' }, { question: 'OK to restart?' }];

  it('should accept every kind in its own shape', () => {
    should(agendaShapeProblems({ kind: 'choice', ask: choice, questions: [{ question: 'Which?' }] })).eql([]);
    should(agendaShapeProblems({ kind: 'reply', ask: { kind: 'open-question' }, questions: several })).eql([]);
    should(agendaShapeProblems({ kind: 'task', ask: { kind: 'task' }, steps: ['One'] })).eql([]);
    should(agendaShapeProblems({ kind: 'info' })).eql([]);
    should(agendaShapeProblems({ kind: 'permission', ask: { kind: 'permission' } })).eql([]);
    should(agendaShapeProblems({ kind: 'review', ask: { kind: 'answer-review' } })).eql([]);
  });

  it('should refuse several questions that are not one reply, or that carry options', () => {
    should(agendaShapeProblems({ kind: 'choice', ask: choice, questions: several })).eql([
      AGENDA_SHAPE_ERRORS.severalQuestions,
    ]);
    should(agendaShapeProblems({ kind: 'permission', ask: { kind: 'permission' }, questions: several })).eql([
      AGENDA_SHAPE_ERRORS.severalQuestions,
    ]);
    should(
      agendaShapeProblems({
        kind: 'reply',
        ask: { kind: 'open-question' },
        questions: [{ question: 'Which?', options: choice.options }, { question: 'Why?' }],
      }),
    ).eql([AGENDA_SHAPE_ERRORS.severalQuestions]);
    should(AGENDA_SHAPE_ERRORS.severalQuestions).startWith(
      'several questions → write them as a numbered list for the owner to answer in the reply',
    );
    should(AGENDA_SHAPE_ERRORS.severalQuestions).endWith('no --option');
  });

  it('should refuse options anywhere but a choice', () => {
    for (const kind of ['reply', 'permission', 'review', 'task', 'info'] as const) {
      should(agendaShapeProblems({ kind, questions: [{ question: 'Which?', options: choice.options }] })).containEql(
        AGENDA_SHAPE_ERRORS.optionsOnlyChoice,
      );
    }
    should(agendaShapeProblems({ kind: 'reply', ask: choice })).eql([AGENDA_SHAPE_ERRORS.optionsOnlyChoice]);
  });

  it('should refuse steps anywhere but a to-do, and a to-do or an info card that asks', () => {
    for (const kind of ['reply', 'choice', 'yesno', 'permission', 'review'] as const) {
      should(agendaShapeProblems({ kind, steps: ['One'] })).containEql(AGENDA_SHAPE_ERRORS.stepsOnlyTodo);
    }
    should(agendaShapeProblems({ kind: 'task', ask: { kind: 'task' }, questions: [{ question: 'Which?' }] })).eql([
      AGENDA_SHAPE_ERRORS.todoAsksNothing,
    ]);
    should(agendaShapeProblems({ kind: 'info', steps: ['One'] })).eql([AGENDA_SHAPE_ERRORS.infoAsksNothing]);
    should(agendaShapeProblems({ kind: 'info', questions: [{ question: 'Which?' }] })).eql([
      AGENDA_SHAPE_ERRORS.infoAsksNothing,
    ]);
  });

  it('should leave a notice and a held-change confirmation to their own fixed shapes', () => {
    should(agendaShapeProblems({ notice: true, steps: ['One'] })).eql([]);
    should(agendaShapeProblems({ confirms: 'machine.yaml', questions: several })).eql([]);
  });

  it('should refuse an edit that gives steps to anything but a to-do', () => {
    should(agendaEditShapeProblems({ kind: 'reply' }, { steps: ['One'] })).eql([AGENDA_SHAPE_ERRORS.stepsOnlyTodo]);
    should(agendaEditShapeProblems({ ask: { kind: 'task' } }, { steps: ['One'] })).eql([]);
    should(agendaEditShapeProblems({ kind: 'reply' }, {})).eql([]);
  });
});

describe('the shipped shape wording', () => {
  it('should say every kind → shape in the one prompt line', () => {
    for (const rule of [
      'choice=ONE question+2–3 `-o "Label: why"`',
      'several/mixed asks (one `-q` each, no options)',
      'todo=`--step`s',
      'info=Got it',
      'permission=Approve/Deny',
    ]) {
      should(AGENDA_SHAPE_LINE).containEql(rule);
    }
  });

  it('should give the help an example raise per kind, under the binary it is given', () => {
    const help = agendaShapeHelp('zz');
    for (const kind of ['choice', 'yesno', 'permission', 'review', 'reply', 'todo', 'info']) {
      should(help).containEql(`e.g. zz agenda add -t "<topic>" --premise … --context … -k ${kind} `);
    }
    should(help).containEql('Options are ONLY for a choice; steps ONLY for a to-do.');
  });

  it('should tell the owner what to do on every shape, under one heading', () => {
    should(AGENDA_NEED_HEADING).equal('What I need from you');
    should(AGENDA_SHAPE_LEADS.reply).equal('Type your answer below.');
    should(AGENDA_SHAPE_LEADS.answers).equal('Reply with your answers below, numbered.');
    should(AGENDA_SHAPE_LEADS.todo).containEql('Mark as done');
    should(AGENDA_SHAPE_LEADS.info).containEql('Got it');
    should(AGENDA_SHAPE_LEADS.approval).equal('Approve or deny.');
  });
});
