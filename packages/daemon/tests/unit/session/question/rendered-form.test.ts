import { describe, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import should from 'should';
import {
  bindQuestionForm,
  bindReviewPage,
  questionScreen,
  type RenderedQuestion,
  screenShowsQuestion,
} from '../../../../src/lib/session/question/rendered-form.ts';

const FIXTURES = join(import.meta.dir, '../../../fixtures/question-forms');
const fixture = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
/** A pane whose whole scrollback is its screen, as the shorter captures were taken. */
const screenOnly = (name: string) => questionScreen(fixture(name), fixture(name));

/** The owner's question, verbatim from the failing report (Claude Code 2.1.281, an 80×24 pane). */
const poolCheck: RenderedQuestion = {
  header: 'Pool check',
  question:
    "Test 4c collapsed, and the next test depends on which pool settings prod's Valkey client really uses. How should we find out?",
  options: [
    {
      label: 'Read one prod pod (Recommended)',
      description:
        'I run a read-only command on one prod Jaeger pod that prints only the pool-setting names and values (e.g. JAEGER_SHARED_REDIS_SECOND_*, POOL/IDLE/AGE keys). Nothing is changed. No secrets are shown.',
    },
    {
      label: "I'll check Vault",
      description:
        "You look in Vault apps/ssp/jaeger for JAEGER_SHARED_REDIS_SECOND_* or bare pool keys, and tell me what's there.",
    },
    {
      label: 'Skip; test with jitter',
      description:
        "Don't confirm. Assume the library defaults and build the next test with staggered connection ages (may need a new generator image).",
    },
  ],
};

const colour: RenderedQuestion = {
  question: 'Which colour should the banner use?',
  options: [{ label: 'Red' }, { label: 'Blue' }],
};
const extras: RenderedQuestion = {
  question: 'Which extras should ship with the banner?',
  multiSelect: true,
  options: [{ label: 'Shadow' }, { label: 'Border' }, { label: 'Icon' }],
};

describe('rendered question form', () => {
  describe('Claude Code 2.1.281', () => {
    it('binds the reported question whose wrapped text carries a │ gutter and whose rows are numbered', () => {
      should(bindQuestionForm(screenOnly('claude-2.1.281-single-80x24'), poolCheck)).deepEqual({
        labels: ['Read one prod pod (Recommended)', "I'll check Vault", 'Skip; test with jitter', 'Other'],
        checked: [false, false, false, false],
        cursor: 0,
        freeForm: { index: 3, entry: 'inline' },
      });
    });

    it('binds the rows on screen and the question in the scrollback when the form is taller than the pane', () => {
      const tall = questionScreen(
        fixture('claude-2.1.281-tall-80x16.visible'),
        fixture('claude-2.1.281-tall-80x16.history'),
      );

      should(tall.visibleFrom).be.above(0);
      should(bindQuestionForm(tall, poolCheck)?.cursor).equal(0);
      // The screen alone no longer holds the question, which is exactly what used to fail.
      should(
        bindQuestionForm(questionScreen(fixture('claude-2.1.281-tall-80x16.visible'), ''), poolCheck),
      ).be.undefined();
    });

    it('never binds on a prompt that quoted the question: only the header below the form border counts', () => {
      // The fixture's prompt, above the form's border, contains this sentence; the form's header does not.
      const echoed: RenderedQuestion = { ...poolCheck, question: 'After I answer, just reply "ok" and stop.' };

      should(fixture('claude-2.1.281-single-80x24')).containEql(echoed.question);
      should(bindQuestionForm(screenOnly('claude-2.1.281-single-80x24'), echoed)).be.undefined();
    });

    it('binds the current tab of a multi-question form and only that one', () => {
      should(bindQuestionForm(screenOnly('claude-2.1.281-multi-q1'), colour)?.labels).deepEqual([
        'Red',
        'Blue',
        'Other',
      ]);
      should(bindQuestionForm(screenOnly('claude-2.1.281-multi-q1'), extras)).be.undefined();
      should(bindQuestionForm(screenOnly('claude-2.1.281-multi-q2-multiselect'), colour)).be.undefined();
    });

    it('reads multi-select boxes and the separate Submit row that ends the page', () => {
      should(bindQuestionForm(screenOnly('claude-2.1.281-multi-q2-multiselect'), extras)).deepEqual({
        labels: ['Shadow', 'Border', 'Icon', 'Other'],
        checked: [false, false, false, false],
        cursor: 0,
        freeForm: { index: 3, entry: 'inline' },
        submit: 4,
      });
      const single = bindQuestionForm(screenOnly('claude-2.1.281-single-multiselect'), {
        question: 'Which extras should ship?',
        multiSelect: true,
        options: [{ label: 'Shadow' }, { label: 'Border' }],
      });
      should(single?.submit).equal(3);
    });

    it('reads ticked boxes and a cursor resting on the Submit row', () => {
      const ticked = [
        '────────────────────────────────────────',
        'Which extras should ship with the banner?',
        '',
        '  1. [✔] Shadow',
        '         Adds a drop shadow.',
        '  2. [ ] Border',
        '  3. [✔] Icon',
        '  4. [ ] Type something',
        '❯    Submit',
        '────────────────────────────────────────',
        '  5. Chat about this',
      ].join('\n');

      should(bindQuestionForm(questionScreen(ticked, ticked), extras)).deepEqual({
        labels: ['Shadow', 'Border', 'Icon', 'Other'],
        checked: [true, false, true, false],
        cursor: 4,
        freeForm: { index: 3, entry: 'inline' },
        submit: 4,
      });
    });

    it('binds the closing review page only for the questions it names', () => {
      should(bindReviewPage(screenOnly('claude-2.1.281-review'), [colour, extras])).deepEqual({ cursor: 0, submit: 0 });
      should(
        bindReviewPage(screenOnly('claude-2.1.281-review'), [colour, { ...extras, question: 'Something else?' }]),
      ).be.undefined();
      should(bindQuestionForm(screenOnly('claude-2.1.281-review'), colour)).be.undefined();
      should(bindReviewPage(screenOnly('claude-2.1.281-multi-q1'), [colour, extras])).be.undefined();
    });
  });

  describe('Codex 0.156.1', () => {
    const codexPool: RenderedQuestion = {
      question:
        'Test 4c collapsed, and the next test depends on which pool settings prod Valkey client really uses. How should we find out?',
      options: [
        { label: 'Read one prod pod (Recommended)' },
        { label: 'I will check Vault' },
        { label: 'Skip; test with jitter' },
      ],
    };

    it('binds two flattened columns, the › cursor, and a None-of-the-above row that takes a note', () => {
      should(bindQuestionForm(screenOnly('codex-0.156.1-single-80x24'), codexPool)).deepEqual({
        labels: ['Read one prod pod (Recommended)', 'I will check Vault', 'Skip; test with jitter', 'Other'],
        checked: [false, false, false, false],
        cursor: 0,
        freeForm: { index: 3, entry: 'notes' },
      });
    });

    it('binds each page of a multi-question form under its Question n/m header', () => {
      const size: RenderedQuestion = {
        question: 'How big should the banner be?',
        options: [{ label: 'Small (Recommended)' }, { label: 'Large' }],
      };
      const codexColour = { ...colour, options: [{ label: 'Red (Recommended)' }, { label: 'Blue' }] };

      should(bindQuestionForm(screenOnly('codex-0.156.1-multi-q1'), codexColour)?.cursor).equal(0);
      should(bindQuestionForm(screenOnly('codex-0.156.1-multi-q1'), size)).be.undefined();
      should(bindQuestionForm(screenOnly('codex-0.156.1-multi-q2'), size)?.labels).deepEqual([
        'Small (Recommended)',
        'Large',
        'Other',
      ]);
    });
  });

  it('refuses a form whose rows are not numbered from 1 or that lacks any recorded option', () => {
    const unnumbered = 'Deploy?\n> Yes\n  No';
    should(
      bindQuestionForm(questionScreen(unnumbered, unnumbered), { question: 'Deploy?', options: [{ label: 'Yes' }] }),
    ).be.undefined();
    const missing = '──────────\nDeploy?\n❯ 1. Yes\n  2. No';
    should(
      bindQuestionForm(questionScreen(missing, missing), {
        question: 'Deploy?',
        options: [{ label: 'Yes' }, { label: 'Later' }],
      }),
    ).be.undefined();
    should(bindQuestionForm(questionScreen(missing, missing), { question: 'Deploy?', options: [] })).be.undefined();
  });

  it('binds a wrapped label and leaves an unnamed row under its own text so it is never chosen', () => {
    const wrapped = [
      '──────────',
      'Pick one?',
      '❯ 1. A label long enough that the harness',
      '     wrapped it',
      '  2. Something the transcript never named',
      '  3. Other',
    ].join('\n');

    should(
      bindQuestionForm(questionScreen(wrapped, wrapped), {
        question: 'Pick one?',
        options: [{ label: 'A label long enough that the harness wrapped it' }],
      }),
    ).deepEqual({
      labels: ['A label long enough that the harness wrapped it', 'Something the transcript never named', 'Other'],
      checked: [false, false, false],
      cursor: 0,
      freeForm: { index: 2, entry: 'page' },
    });
  });

  it('ignores a scrollback that does not end with the screen, rather than splice two instants', () => {
    const screen = questionScreen('row a\nrow b', 'older\nrow a\nrow c');
    should(screen).deepEqual({ lines: ['row a', 'row b'], visibleFrom: 0 });
  });

  it('finds a free-form page question on the screen only', () => {
    const page = questionScreen('Tell me more about the\nrollout plan', 'Tell me more about the\nrollout plan');
    should(screenShowsQuestion(page, 'Tell me more about the rollout plan')).be.true();
    should(screenShowsQuestion(questionScreen('nothing', 'Tell me\nnothing'), 'Tell me')).be.false();
  });
});
