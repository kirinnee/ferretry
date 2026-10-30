import { describe, it } from 'bun:test';
import should from 'should';
import {
  AgendaActionRequestSchema,
  AgendaItemSchema,
  AgendaQuestionSchema,
  agendaBriefOf,
  MAX_AGENDA_BODY_LENGTH,
  MAX_AGENDA_QUESTIONS,
  MAX_AGENDA_STEP_LENGTH,
  MAX_AGENDA_STEPS,
  MAX_AGENDA_TERMS,
  recommendedAgendaOption,
  singleAgendaQuestion,
} from '../../src/lib/agenda.ts';

const AT = '2026-10-26T09:00:00.000Z';

const minimal = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approve the OCI work-login plan',
  why: 'Approve the OCI work-login plan',
  waitingSince: AT,
  howToResolve: 'Answer this item on the agenda board.',
  ask: { kind: 'open-question' },
  raisedBy: 'agent',
  raisedBySession: 'session-1',
  raisedByName: 'Olivier',
} as const;

const plan = {
  question: 'Which plan should I build?',
  options: [{ label: 'Go with the defaults' }, { label: 'Reply with changes' }],
  recommended: 'Go with the defaults',
  why: 'They match what you approved last week.',
};

describe('attention brief', () => {
  it('should read an item raised before the brief existed, with nothing structured on it', () => {
    // Arrange / Act
    const item = AgendaItemSchema.parse(minimal);

    // Assert
    should(agendaBriefOf(item)).deepEqual({});
    should(singleAgendaQuestion(item)).be.undefined();
    should(recommendedAgendaOption(item)).be.undefined();
  });

  it('should carry every structured field through an add request and an item', () => {
    // Arrange
    const brief = {
      terms: [{ term: 'OCI', meaning: 'Oracle Cloud Infrastructure.' }],
      questions: [plan, { question: 'Keep the 30-minute keepalive?' }],
      recommendation: { decision: 'Go with the defaults and keep the keepalive.', why: 'It is what works today.' },
      impact: 'You stay logged out of every work account.',
      urgency: 'today',
      links: [{ label: 'Plan', target: '#F12' }, { target: 'https://github.com/kirinnee/ferretry/pull/1' }],
    };

    // Act
    const request = AgendaActionRequestSchema.parse({
      action: 'add',
      subject: minimal.subject,
      why: minimal.why,
      howToResolve: minimal.howToResolve,
      ask: { kind: 'open-question' },
      ...brief,
    });
    const item = AgendaItemSchema.parse({ ...minimal, ...brief });

    // Assert
    should(request).containDeep(brief);
    should(agendaBriefOf(item)).deepEqual(brief);
    should(singleAgendaQuestion(item)).be.undefined();
  });

  it('should carry a premise and what was decided, turning a list into bullets, through the request and the item', () => {
    // Arrange
    const asList = {
      premise: ['The work login expires every day', 'A plan exists'],
      decided: ['Use the shared account'],
    };
    const asText = { premise: 'The work login expires every day.', decided: '- You chose the shared account' };

    // Act
    const request = AgendaActionRequestSchema.parse({
      action: 'add',
      subject: minimal.subject,
      why: minimal.why,
      howToResolve: minimal.howToResolve,
      ask: { kind: 'open-question' },
      ...asList,
    });
    const edit = AgendaActionRequestSchema.parse({ action: 'edit', id: 'A1', ...asList });
    const item = AgendaItemSchema.parse({ ...minimal, ...asText });

    // Assert
    should(request).containDeep({
      premise: '- The work login expires every day\n- A plan exists',
      decided: '- Use the shared account',
    });
    should(edit).containDeep({ premise: '- The work login expires every day\n- A plan exists' });
    should(agendaBriefOf(item)).deepEqual(asText);
    should(agendaBriefOf(AgendaItemSchema.parse(minimal))).not.have.property('premise');
    should(agendaBriefOf(AgendaItemSchema.parse(minimal))).not.have.property('decided');
  });

  it('should refuse a blank or oversized premise', () => {
    // Arrange / Act / Assert
    should(AgendaItemSchema.safeParse({ ...minimal, premise: '   ' }).success).be.false();
    should(AgendaItemSchema.safeParse({ ...minimal, decided: 'x'.repeat(10_000) }).success).be.false();
  });

  it('should carry steps, a body and progress, and refuse what is over the limit or inconsistent', () => {
    // Arrange
    const steps = ['Run `fy login`', 'Paste the code'];
    const withSteps = { ...minimal, steps, body: '## Notes\n\n```sh\nfy login\n```' };

    // Act
    const item = AgendaItemSchema.parse({ ...withSteps, stepsDone: [0, 1] });
    const request = AgendaActionRequestSchema.safeParse({
      action: 'add',
      subject: minimal.subject,
      why: minimal.why,
      howToResolve: minimal.howToResolve,
      ask: { kind: 'open-question' },
      steps,
    });
    const progress = AgendaActionRequestSchema.safeParse({ action: 'progress', id: 'A1', step: 0, done: false });
    const extra = AgendaActionRequestSchema.safeParse({ action: 'progress', id: 'A1', step: 0, done: true, x: 1 });
    const tooManySteps = AgendaItemSchema.safeParse({
      ...minimal,
      steps: Array.from({ length: MAX_AGENDA_STEPS + 1 }, () => 'x'),
    });
    const longStep = AgendaItemSchema.safeParse({ ...minimal, steps: ['x'.repeat(MAX_AGENDA_STEP_LENGTH + 1)] });
    const longBody = AgendaItemSchema.safeParse({ ...minimal, body: 'x'.repeat(MAX_AGENDA_BODY_LENGTH + 1) });
    const noSteps = AgendaItemSchema.safeParse({ ...minimal, steps: [] });
    const unsorted = AgendaItemSchema.safeParse({ ...withSteps, stepsDone: [1, 0] });
    const repeated = AgendaItemSchema.safeParse({ ...withSteps, stepsDone: [1, 1] });
    const outOfRange = AgendaItemSchema.safeParse({ ...withSteps, stepsDone: [2] });
    const withoutSteps = AgendaItemSchema.safeParse({ ...minimal, stepsDone: [0] });
    const empty = AgendaItemSchema.safeParse({ ...withSteps, stepsDone: [] });

    // Assert
    should(item.stepsDone).deepEqual([0, 1]);
    should(agendaBriefOf(item)).containDeep({ steps, body: withSteps.body });
    should(request.success).be.true();
    should(progress.success).be.true();
    should(extra.success).be.false();
    for (const refused of [
      tooManySteps,
      longStep,
      longBody,
      noSteps,
      unsorted,
      repeated,
      outOfRange,
      withoutSteps,
      empty,
    ]) {
      should(refused.success).be.false();
    }
    should(JSON.stringify(longStep.error?.issues)).containEql('steps');
    should(JSON.stringify(longBody.error?.issues)).containEql('body');
  });

  it('should take a recommendation only when it names one of the options', () => {
    // Arrange / Act
    const named = AgendaQuestionSchema.safeParse(plan);
    const unnamed = AgendaQuestionSchema.safeParse({ ...plan, recommended: 'Something else' });
    const worded = AgendaQuestionSchema.safeParse({ question: 'Which region?', recommended: 'eu-west-1' });
    const repeated = AgendaQuestionSchema.safeParse({
      question: 'Pick one',
      options: [{ label: 'A' }, { label: 'A' }],
    });

    // Assert
    should(named.success).be.true();
    should(unnamed.success).be.false();
    should(worded.success).be.true();
    should(repeated.success).be.false();
  });

  it('should bound the brief', () => {
    // Arrange
    const term = { term: 'x', meaning: 'y' };
    const question = { question: 'Why?' };

    // Act
    const tooManyTerms = AgendaItemSchema.safeParse({
      ...minimal,
      terms: Array.from({ length: MAX_AGENDA_TERMS + 1 }, () => term),
    });
    const tooManyQuestions = AgendaItemSchema.safeParse({
      ...minimal,
      questions: Array.from({ length: MAX_AGENDA_QUESTIONS + 1 }, () => question),
    });
    const multiLineUrgency = AgendaItemSchema.safeParse({ ...minimal, urgency: 'today\nor tomorrow' });
    const emptyTerms = AgendaItemSchema.safeParse({ ...minimal, terms: [] });

    // Assert
    should(tooManyTerms.success).be.false();
    should(tooManyQuestions.success).be.false();
    should(multiLineUrgency.success).be.false();
    should(emptyTerms.success).be.false();
  });

  it('should name the recommended option from the single question, then from the overall recommendation', () => {
    // Arrange
    const ask = { kind: 'multiple-choice', options: plan.options } as const;
    const fromQuestion = AgendaItemSchema.parse({ ...minimal, ask, questions: [plan] });
    const fromOverall = AgendaItemSchema.parse({
      ...minimal,
      ask,
      recommendation: { decision: 'Reply with changes' },
    });
    const wordedOverall = AgendaItemSchema.parse({ ...minimal, ask, recommendation: { decision: 'Wait a day' } });

    // Act / Assert
    should(singleAgendaQuestion(fromQuestion)).deepEqual(plan);
    should(recommendedAgendaOption(fromQuestion)).equal('Go with the defaults');
    should(recommendedAgendaOption(fromOverall)).equal('Reply with changes');
    should(recommendedAgendaOption(wordedOverall)).be.undefined();
  });
});

const base = { why: 'Needs a decision', howToResolve: 'Answer the question', ask: { kind: 'open-question' } } as const;

describe('attention writing shapes', () => {
  it('should turn a list of context and impact points into markdown bullets', () => {
    const add = AgendaActionRequestSchema.parse({
      action: 'add',
      ...base,
      subject: 'Pick a plan',
      context: ['the old login expires', '  two plans   fit ', ' '],
      impact: ['blocks the release', 'costs a day'],
    });

    should(add).containDeep({
      context: '- the old login expires\n- two plans fit',
      impact: '- blocks the release\n- costs a day',
    });
  });

  it('should keep a string as written, and refuse a list of non-text', () => {
    const add = AgendaActionRequestSchema.parse({ action: 'add', ...base, subject: 'Pick', context: 'plain words' });

    should(add).containDeep({ context: 'plain words' });
    should(
      AgendaActionRequestSchema.safeParse({ action: 'add', ...base, subject: 'Pick', context: [1] }).success,
    ).be.false();
  });

  it('should accept an edit with lists, a null context and no other field, and refuse an unknown key', () => {
    const edit = AgendaActionRequestSchema.parse({ action: 'edit', id: 'A1', context: null, impact: ['one'] });

    should(edit).containDeep({ action: 'edit', id: 'A1', context: null, impact: '- one' });
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', note: 'x' }).success).be.false();
  });
});

describe('agenda option details', () => {
  const choice = {
    ...minimal,
    ask: { kind: 'multiple-choice', options: [{ label: 'Go' }, { label: 'Wait' }] },
  } as const;
  const raise = {
    action: 'add',
    subject: 'Pick',
    why: 'Pick',
    howToResolve: 'Answer it.',
    ask: choice.ask,
  } as const;

  it('should read an item with a Markdown detail per option, and carry it in the brief', () => {
    // Arrange / Act
    const item = AgendaItemSchema.parse({
      ...choice,
      optionDetails: [{ label: 'Go', detail: 'Ship it **now**, see `plan.md`.' }],
    });

    // Assert
    should(agendaBriefOf(item).optionDetails).deepEqual([{ label: 'Go', detail: 'Ship it **now**, see `plan.md`.' }]);
  });

  it('should leave the option objects as strict as older apps read them', () => {
    // Arrange / Act
    const withDetail = AgendaItemSchema.safeParse({
      ...choice,
      ask: { kind: 'multiple-choice', options: [{ label: 'Go', detail: 'x' }, { label: 'Wait' }] },
    });

    // Assert
    should(withDetail.success).be.false();
  });

  it('should accept details on an add and an edit, and read the options of questions and card answers too', () => {
    // Arrange
    const details = [{ label: 'Go', detail: 'Now.' }];

    // Act / Assert
    should(AgendaActionRequestSchema.safeParse({ ...raise, optionDetails: details }).success).be.true();
    should(AgendaActionRequestSchema.safeParse({ action: 'edit', id: 'A1', optionDetails: details }).success).be.true();
    should(
      AgendaActionRequestSchema.safeParse({
        action: 'add',
        subject: 'Pick',
        why: 'Pick',
        howToResolve: 'Answer it.',
        questions: [plan],
        optionDetails: [{ label: 'Reply with changes', detail: 'Say what.' }],
      }).success,
    ).be.true();
  });

  it('should refuse a detail that names no option, one option twice, and a bad detail', () => {
    // Arrange / Act
    const unknown = AgendaActionRequestSchema.safeParse({ ...raise, optionDetails: [{ label: 'Stop', detail: 'x' }] });
    const twice = AgendaActionRequestSchema.safeParse({
      ...raise,
      optionDetails: [
        { label: 'Go', detail: 'a' },
        { label: 'Go', detail: 'b' },
      ],
    });
    const blank = AgendaActionRequestSchema.safeParse({ ...raise, optionDetails: [{ label: 'Go', detail: '  ' }] });
    const long = AgendaActionRequestSchema.safeParse({
      ...raise,
      optionDetails: [{ label: 'Go', detail: 'x'.repeat(1_001) }],
    });
    const multiline = AgendaActionRequestSchema.safeParse({
      ...raise,
      optionDetails: [{ label: 'Go\nStop', detail: 'x' }],
    });
    const stored = AgendaItemSchema.safeParse({ ...choice, optionDetails: [{ label: 'Stop', detail: 'x' }] });

    // Assert
    should(unknown.success).be.false();
    should(unknown.error?.issues[0]?.message).containEql('"Stop"');
    should(twice.success).be.false();
    should(blank.success).be.false();
    should(long.success).be.false();
    should(multiline.success).be.false();
    should(stored.success).be.false();
    should(stored.error?.issues.map(issue => issue.message).join()).containEql('"Stop"');
  });

  it('should allow at most one detail per option the schema offers', () => {
    // Arrange
    const many = Array.from({ length: 13 }, (_, index) => ({ label: `O${index}`, detail: 'x' }));

    // Act / Assert
    should(AgendaActionRequestSchema.safeParse({ ...raise, optionDetails: many }).success).be.false();
    should(AgendaActionRequestSchema.safeParse({ ...raise, optionDetails: [] }).success).be.false();
  });
});
