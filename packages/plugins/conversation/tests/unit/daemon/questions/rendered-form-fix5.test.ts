import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { fixtureTexts } from '../../../support/fixtures.ts';
import {
  bindQuestionForm,
  freeFormPageShown,
  numberedFormShown,
  questionScreen,
  type RenderedQuestion,
  surfaceOf,
  surfaceStillShown,
} from '../../../../daemon/questions/lib/rendered-form.ts';

/**
 * IDENTITY IS POSITIONAL (rv5 findings 2 and 4): the header is accepted only as [tab strip] [Codex `Question n/m`]
 * [the stored header's chip] and then the question's text, compared literally. A line is decoration because of where it
 * is and that it has the harness's exact form — never because its text looks like decoration.
 */

const FIXTURES = join(import.meta.dir, '../../../fixtures/question-forms');
const text = await fixtureTexts(FIXTURES);
const claude = text('claude-2.1.281-single-80x24.txt');
const codex = text('codex-0.164.0-single.txt');
const screen = (visible: string) => questionScreen(visible, visible);

const question =
  "Test 4c collapsed, and the next test depends on which pool settings prod's Valkey client really uses. How should we find out?";
const pending: RenderedQuestion = {
  header: 'Pool check',
  question,
  options: [
    { label: 'Read one prod pod (Recommended)' },
    { label: "I'll check Vault" },
    { label: 'Skip; test with jitter' },
  ],
};
/** The recorded Claude pane with its two gutter lines of question text replaced by `body`. */
const drawnQuestion = (body: string) => claude.replace(/│ Test[^\n]*\n│ Valkey[^\n]*/u, body);

describe('the question text is its own, whatever it looks like', () => {
  for (const literal of ['☐ Include optional tests?', 'Question 1/2: should we deploy?', '← Which direction? →'])
    it(`binds ${literal} on the recorded Claude layout`, () => {
      should(bindQuestionForm(screen(drawnQuestion(literal)), { ...pending, question: literal })).not.be.undefined();
      // A question that stored no header still has the harness's own chip set aside, in its one place.
      const { header: _header, ...unnamed } = pending;
      should(bindQuestionForm(screen(drawnQuestion(literal)), { ...unnamed, question: literal })).not.be.undefined();
      const noChip = drawnQuestion(literal).replace(' ☐ Pool check\n\n', '');
      should(bindQuestionForm(screen(noChip), { ...unnamed, question: literal })).not.be.undefined();
    });

  it('binds a question that is exactly a Codex header or a tab strip, and a gutter-drawn checkbox line', () => {
    for (const literal of ['Question 1/2 (2 unanswered)', '← ☐ Pool check  ✔ Submit →', '☐ Pool check'])
      should(
        bindQuestionForm(screen(drawnQuestion(`│ ${literal}`)), { ...pending, question: literal }),
      ).not.be.undefined();
  });

  it('still refuses a question that is only part of what is drawn', () => {
    should(
      bindQuestionForm(screen(drawnQuestion('☐ Include optional tests?')), {
        ...pending,
        question: 'Include optional tests?',
      }),
    ).be.undefined();
    should(
      bindQuestionForm(screen(drawnQuestion('Question 1/2: should we deploy?')), {
        ...pending,
        question: 'should we deploy?',
      }),
    ).be.undefined();
  });
});

describe('only the exact decoration, in its own place, is set aside', () => {
  const RULE = '─'.repeat(40);
  const deploy: RenderedQuestion = {
    header: 'Deploy',
    question: 'Deploy?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  };
  const rows = ['❯ 1. Yes', '  2. No', RULE, '  3. Chat about this'];
  const form = (...head: string[]) => screen([RULE, ...head, ...rows].join('\n'));

  it('accepts the strip, then the chip, then the question', () => {
    should(bindQuestionForm(form('Deploy?'), deploy)).not.be.undefined();
    should(bindQuestionForm(form(' ☐ Deploy', '', 'Deploy?'), deploy)).not.be.undefined();
    should(bindQuestionForm(form('←  ☐ Deploy  ✔ Submit  →', '', 'Deploy?'), deploy)).not.be.undefined();
    should(bindQuestionForm(form('←  ☐ Deploy  ✔ Submit  →', ' ☐ Deploy', 'Deploy?'), deploy)).not.be.undefined();
    should(bindQuestionForm(form('  Question 1/1 (1 unanswered)', 'Deploy?'), deploy)).not.be.undefined();
    should(bindQuestionForm(form('  Question 1/2', 'Deploy?'), deploy)).not.be.undefined();
  });

  it('refuses a chip that is not the stored header, in the wrong place, or not the whole line', () => {
    should(bindQuestionForm(form(' ☐ Approval required for a different operation', 'Deploy?'), deploy)).be.undefined();
    should(bindQuestionForm(form('Deploy?', ' ☐ Deploy'), deploy)).be.undefined();
    should(bindQuestionForm(form(' ☐ Deploy', ' ☐ Deploy', 'Deploy?'), deploy)).be.undefined();
    should(bindQuestionForm(form(' ☐ Deploy now', 'Deploy?'), deploy)).be.undefined();
    should(bindQuestionForm(form(' ☐ Deploy', ' ☐ Another', 'Deploy?'), deploy)).be.undefined();
  });

  it('sets aside, for a question that stored no header, only the harness’s own chip in its one place', () => {
    const unnamed: RenderedQuestion = { question: 'Deploy?', options: deploy.options };
    should(bindQuestionForm(form('Deploy?'), unnamed)).not.be.undefined();
    // First line, short label, blank line, then the question: the shape Claude draws.
    should(bindQuestionForm(form(' ☐ Deploy', '', 'Deploy?'), unnamed)).not.be.undefined();
    // A heading with nothing between it and the question, or a label no header could be, or a second one: a foreign heading.
    should(bindQuestionForm(form(' ☐ Approval required for a different operation', 'Deploy?'), unnamed)).be.undefined();
    should(bindQuestionForm(form(' ☐ Deploy', 'Deploy?'), unnamed)).be.undefined();
    should(
      bindQuestionForm(form(' ☐ Approval required for a different operation', '', 'Deploy?'), unnamed),
    ).be.undefined();
    should(bindQuestionForm(form(' ☐ Deploy', '', ' ☐ Deploy', '', 'Deploy?'), unnamed)).be.undefined();
    should(bindQuestionForm(form('  Question 1/1', ' ☐ Deploy', '', 'Deploy?'), unnamed)).be.undefined();
  });

  it('refuses a strip or Codex header in a form that is not the harness’s, or that names another question', () => {
    should(bindQuestionForm(form('  Question 1/1: now', 'Deploy?'), deploy)).be.undefined();
    should(bindQuestionForm(form('  Question 1/1 (soon)', 'Deploy?'), deploy)).be.undefined();
    // A strip that names no tab of this question is another form's.
    should(bindQuestionForm(form('←  ☐ Other  ✔ Submit  →', 'Deploy?'), deploy)).be.undefined();
    // A strip that does not end on Submit is only arrows around text.
    should(bindQuestionForm(form('←  ☐ Deploy  ☐ Other  →', 'Deploy?'), deploy)).be.undefined();
    // Nor does a strip count once something sits between it and the question.
    should(bindQuestionForm(form('←  ☐ Deploy  ✔ Submit  →', 'A subtitle', 'Deploy?'), deploy)).be.undefined();
  });

  it('keeps the free-form page to the same rule', () => {
    const page = (...head: string[]) => screen([...head, 'Deploy?', '', 'Type your answer: █'].join('\n'));
    const unnamed: RenderedQuestion = { question: 'Deploy?', options: deploy.options };
    should(freeFormPageShown(page(' ☐ Deploy'), deploy)).be.true();
    should(freeFormPageShown(page(' ☐ Deploy'), unnamed)).be.false();
    should(freeFormPageShown(page(' ☐ Approval required for a different operation'), unnamed)).be.false();
    should(freeFormPageShown(page(), unnamed)).be.true();
  });
});

describe('layouts recorded from the harnesses keep binding', () => {
  for (const width of [12, 20, 32, 52])
    it(`a native question wrapped at width ${width}, Unicode included`, () => {
      const wrap = (value: string) =>
        (value.match(new RegExp(`.{1,${width}}`, 'gu')) ?? []).map(part => `│ ${part}`).join('\n');
      for (const body of [question, 'Réviser 日本語 🚀: should the next carefully reviewed build be released?'])
        should(bindQuestionForm(screen(drawnQuestion(wrap(body))), { ...pending, question: body })).not.be.undefined();
    });

  it('a truncated own chip, Unicode labels and a wrapped option label', () => {
    const pane = claude.replace('☐ Pool check', '☐ Pool…').replace("I'll check Vault", '日本語 🚀');
    should(
      bindQuestionForm(screen(pane), {
        ...pending,
        options: [pending.options![0]!, { label: '日本語 🚀' }, pending.options![2]!],
      }),
    ).not.be.undefined();
    const wrapped = claude.replace('1. Read one prod pod (Recommended)', '1. Read one prod\n     pod (Recommended)');
    should(bindQuestionForm(screen(wrapped), pending)).not.be.undefined();
  });

  it('a long typed inline row drawn with a known prefix and an ellipsis', () => {
    const bound = bindQuestionForm(screen(claude), pending) as NonNullable<ReturnType<typeof bindQuestionForm>>;
    const pane = claude.replace('Type something.', 'Ask the on-call…');
    should(
      surfaceStillShown(screen(pane), pending, surfaceOf(bound), {
        index: 3,
        text: 'Ask the on-call to check all of the settings before running the test',
      }),
    ).be.true();
  });

  it('extra subtitles, a truncated option and an option wrapped over four lines still refuse', () => {
    should(
      bindQuestionForm(
        screen(claude.replace(' ☐ Pool check', ' ☐ Pool check\nA subtitle the stored question never named')),
        pending,
      ),
    ).be.undefined();
    should(
      bindQuestionForm(screen(claude.replace('1. Read one prod pod (Recommended)', '1. Read one prod…')), pending),
    ).be.undefined();
    should(
      bindQuestionForm(
        screen(
          claude.replace('1. Read one prod pod (Recommended)', '1. Read\n     one prod\n     pod\n     (Recommended)'),
        ),
        pending,
      ),
    ).be.undefined();
  });
});

describe('a numbered question surface is recognised whole, cursorless or cropped (rv5 finding 3)', () => {
  const lines = codex.split('\n');
  const firstRow = lines.findIndex(line => /^\s*[›>]?\s*1\. /u.test(line));
  const cursorless = codex.replace(/›(?=\s*\d+\.)/gu, ' ');
  const cropped = lines.slice(firstRow + 1).join('\n');

  it('sees the whole form, the form with its cursor gone, and the form cropped at the top', () => {
    should(numberedFormShown(screen(codex))).be.true();
    should(numberedFormShown(screen(cursorless))).be.true();
    should(numberedFormShown(screen(cropped))).be.true();
    should(numberedFormShown(screen(cropped.replace(/›(?=\s*\d+\.)/gu, ' ').replace(/›?\s*2\./u, '  2.')))).be.true();
  });

  it('does not see an ordinary working pane, a prompt, or a transcript that merely lists things', () => {
    should(numberedFormShown(screen('● Working (3s • esc to interrupt)\n\n› '))).be.false();
    should(numberedFormShown(screen('> '))).be.false();
    should(
      numberedFormShown(
        screen(
          'I changed three things:\n\n    1. the parser\n    2. the driver\n    3. the tests\n\n✻ Working… (esc to interrupt)',
        ),
      ),
    ).be.false();
  });

  it('sees only the live screen, never numbered rows left in the scrollback', () => {
    const history = `${cursorless}\n${'\n'.repeat(3)}> `;
    should(numberedFormShown(questionScreen('> ', history))).be.false();
  });
});
