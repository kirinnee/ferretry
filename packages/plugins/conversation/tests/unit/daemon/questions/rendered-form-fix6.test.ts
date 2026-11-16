import { describe, it } from 'bun:test';
import { join } from 'node:path';
import should from 'should';
import { fixtureTexts } from '../../../support/fixtures.ts';
import {
  bindQuestionForm,
  questionScreen,
  type RenderedQuestion,
} from '../../../../daemon/questions/lib/rendered-form.ts';

/**
 * THE FORM'S TOP IS STRUCTURAL AND EVERYTHING BELOW IT IS CONSUMED (rv6 findings 1 and 2).
 *
 * The top is the harness's rule, or its exact opening (Claude's strip, Codex's `  Question n/m`) standing directly under
 * a blank line, as every recorded pane draws it. A decoration-shaped line under other text is that text's line, and
 * nothing is promoted to a top by its shape alone.
 */

const FIXTURES = join(import.meta.dir, '../../../fixtures/question-forms');
const text = await fixtureTexts(FIXTURES);
const codex = text('codex-0.164.0-single.txt');
const claude = text('claude-2.1.281-single-80x24.txt');
const screen = (visible: string) => questionScreen(visible, visible);

const codexQuestion: RenderedQuestion = {
  header: 'Pool',
  question: 'Test 4c collapsed. How should we find out?',
  options: [
    { label: 'Read one prod pod (Recommended)' },
    { label: 'I will check Vault' },
    { label: 'Skip; test with jitter' },
    { label: 'Other' },
  ],
};
const header = '  Question 1/1 (1 unanswered)';

describe('a Codex form, whose top is its own header under a blank line', () => {
  it('binds the recorded pane', () => {
    should(bindQuestionForm(screen(codex), codexQuestion)).not.be.undefined();
  });

  it('refuses a header that stands directly under other text: that text is part of the form to consume', () => {
    should(
      bindQuestionForm(screen(codex.replace(`\n\n${header}\n`, `\nAn unrelated approval\n${header}\n`)), codexQuestion),
    ).be.undefined();
  });

  it('refuses a header with no blank line above it in the capture (nothing above is known)', () => {
    const lines = codex.split('\n');
    const at = lines.indexOf(header);
    should(bindQuestionForm(screen(lines.slice(at).join('\n')), codexQuestion)).be.undefined();
  });

  it('refuses a header drawn at the wrong indent: only the recorded opening is a top', () => {
    should(
      bindQuestionForm(screen(codex.replace(header, 'Question 1/1 (1 unanswered)')), codexQuestion),
    ).be.undefined();
  });

  it('refuses a stray line between the header and the question', () => {
    should(
      bindQuestionForm(
        screen(codex.replace(`${header}\n`, `${header}\n  Approval for another operation\n`)),
        codexQuestion,
      ),
    ).be.undefined();
  });
});

describe('a Claude form, whose top is its rule', () => {
  const pool: RenderedQuestion = {
    header: 'Pool check',
    question:
      "Test 4c collapsed, and the next test depends on which pool settings prod's Valkey client really uses. How should we find out?",
    options: [
      { label: 'Read one prod pod (Recommended)' },
      { label: "I'll check Vault" },
      { label: 'Skip; test with jitter' },
    ],
  };

  it('binds the recorded pane, and refuses it without its stored header: no chip is guessed', () => {
    should(bindQuestionForm(screen(claude), pool)).not.be.undefined();
    const { header: _header, ...unnamed } = pool;
    should(bindQuestionForm(screen(claude), unnamed)).be.undefined();
  });

  it('refuses a foreign line between the rule and the chip', () => {
    should(
      bindQuestionForm(screen(claude.replace(' ☐ Pool check', 'Allow all future operations?\n ☐ Pool check')), pool),
    ).be.undefined();
  });

  it('refuses when no top exists within reach: a form with no known top is not read', () => {
    const lines = claude.split('\n');
    const rule = lines.findIndex(line => line.startsWith('────'));
    should(bindQuestionForm(screen(lines.slice(rule + 1).join('\n')), pool)).be.undefined();
  });
});
