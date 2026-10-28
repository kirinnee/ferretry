import { describe, it } from 'bun:test';
import should from 'should';
import {
  AttentionActionRequestSchema,
  AttentionItemSchema,
  AttentionQuestionSchema,
  attentionBriefOf,
  MAX_ATTENTION_BODY_LENGTH,
  MAX_ATTENTION_QUESTIONS,
  MAX_ATTENTION_STEP_LENGTH,
  MAX_ATTENTION_STEPS,
  MAX_ATTENTION_TERMS,
  recommendedAttentionOption,
  singleAttentionQuestion,
} from '../../src/lib/attention.ts';

const AT = '2026-10-26T09:00:00.000Z';

const minimal = {
  id: 'A1',
  source: 'agent-raised',
  sourceRef: null,
  subject: 'Approve the OCI work-login plan',
  why: 'Approve the OCI work-login plan',
  waitingSince: AT,
  howToResolve: 'Answer this item on the attention board.',
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
    const item = AttentionItemSchema.parse(minimal);

    // Assert
    should(attentionBriefOf(item)).deepEqual({});
    should(singleAttentionQuestion(item)).be.undefined();
    should(recommendedAttentionOption(item)).be.undefined();
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
    const request = AttentionActionRequestSchema.parse({
      action: 'add',
      subject: minimal.subject,
      why: minimal.why,
      howToResolve: minimal.howToResolve,
      ask: { kind: 'open-question' },
      ...brief,
    });
    const item = AttentionItemSchema.parse({ ...minimal, ...brief });

    // Assert
    should(request).containDeep(brief);
    should(attentionBriefOf(item)).deepEqual(brief);
    should(singleAttentionQuestion(item)).be.undefined();
  });

  it('should carry steps, a body and progress, and refuse what is over the limit or inconsistent', () => {
    // Arrange
    const steps = ['Run `fy login`', 'Paste the code'];
    const withSteps = { ...minimal, steps, body: '## Notes\n\n```sh\nfy login\n```' };

    // Act
    const item = AttentionItemSchema.parse({ ...withSteps, stepsDone: [0, 1] });
    const request = AttentionActionRequestSchema.safeParse({
      action: 'add',
      subject: minimal.subject,
      why: minimal.why,
      howToResolve: minimal.howToResolve,
      ask: { kind: 'open-question' },
      steps,
    });
    const progress = AttentionActionRequestSchema.safeParse({ action: 'progress', id: 'A1', step: 0, done: false });
    const extra = AttentionActionRequestSchema.safeParse({ action: 'progress', id: 'A1', step: 0, done: true, x: 1 });
    const tooManySteps = AttentionItemSchema.safeParse({
      ...minimal,
      steps: Array.from({ length: MAX_ATTENTION_STEPS + 1 }, () => 'x'),
    });
    const longStep = AttentionItemSchema.safeParse({ ...minimal, steps: ['x'.repeat(MAX_ATTENTION_STEP_LENGTH + 1)] });
    const longBody = AttentionItemSchema.safeParse({ ...minimal, body: 'x'.repeat(MAX_ATTENTION_BODY_LENGTH + 1) });
    const noSteps = AttentionItemSchema.safeParse({ ...minimal, steps: [] });
    const unsorted = AttentionItemSchema.safeParse({ ...withSteps, stepsDone: [1, 0] });
    const repeated = AttentionItemSchema.safeParse({ ...withSteps, stepsDone: [1, 1] });
    const outOfRange = AttentionItemSchema.safeParse({ ...withSteps, stepsDone: [2] });
    const withoutSteps = AttentionItemSchema.safeParse({ ...minimal, stepsDone: [0] });
    const empty = AttentionItemSchema.safeParse({ ...withSteps, stepsDone: [] });

    // Assert
    should(item.stepsDone).deepEqual([0, 1]);
    should(attentionBriefOf(item)).containDeep({ steps, body: withSteps.body });
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
    const named = AttentionQuestionSchema.safeParse(plan);
    const unnamed = AttentionQuestionSchema.safeParse({ ...plan, recommended: 'Something else' });
    const worded = AttentionQuestionSchema.safeParse({ question: 'Which region?', recommended: 'eu-west-1' });
    const repeated = AttentionQuestionSchema.safeParse({
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
    const tooManyTerms = AttentionItemSchema.safeParse({
      ...minimal,
      terms: Array.from({ length: MAX_ATTENTION_TERMS + 1 }, () => term),
    });
    const tooManyQuestions = AttentionItemSchema.safeParse({
      ...minimal,
      questions: Array.from({ length: MAX_ATTENTION_QUESTIONS + 1 }, () => question),
    });
    const multiLineUrgency = AttentionItemSchema.safeParse({ ...minimal, urgency: 'today\nor tomorrow' });
    const emptyTerms = AttentionItemSchema.safeParse({ ...minimal, terms: [] });

    // Assert
    should(tooManyTerms.success).be.false();
    should(tooManyQuestions.success).be.false();
    should(multiLineUrgency.success).be.false();
    should(emptyTerms.success).be.false();
  });

  it('should name the recommended option from the single question, then from the overall recommendation', () => {
    // Arrange
    const ask = { kind: 'multiple-choice', options: plan.options } as const;
    const fromQuestion = AttentionItemSchema.parse({ ...minimal, ask, questions: [plan] });
    const fromOverall = AttentionItemSchema.parse({
      ...minimal,
      ask,
      recommendation: { decision: 'Reply with changes' },
    });
    const wordedOverall = AttentionItemSchema.parse({ ...minimal, ask, recommendation: { decision: 'Wait a day' } });

    // Act / Assert
    should(singleAttentionQuestion(fromQuestion)).deepEqual(plan);
    should(recommendedAttentionOption(fromQuestion)).equal('Go with the defaults');
    should(recommendedAttentionOption(fromOverall)).equal('Reply with changes');
    should(recommendedAttentionOption(wordedOverall)).be.undefined();
  });
});

const base = { why: 'Needs a decision', howToResolve: 'Answer the question', ask: { kind: 'open-question' } } as const;

describe('attention writing shapes', () => {
  it('should turn a list of context and impact points into markdown bullets', () => {
    const add = AttentionActionRequestSchema.parse({
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
    const add = AttentionActionRequestSchema.parse({ action: 'add', ...base, subject: 'Pick', context: 'plain words' });

    should(add).containDeep({ context: 'plain words' });
    should(
      AttentionActionRequestSchema.safeParse({ action: 'add', ...base, subject: 'Pick', context: [1] }).success,
    ).be.false();
  });

  it('should accept an edit with lists, a null context and no other field, and refuse an unknown key', () => {
    const edit = AttentionActionRequestSchema.parse({ action: 'edit', id: 'A1', context: null, impact: ['one'] });

    should(edit).containDeep({ action: 'edit', id: 'A1', context: null, impact: '- one' });
    should(AttentionActionRequestSchema.safeParse({ action: 'edit', id: 'A1', note: 'x' }).success).be.false();
  });
});
