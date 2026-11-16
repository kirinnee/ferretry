import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { fixtureTexts } from '../../../support/fixtures.ts';
import { questionScreen, readOpenForm } from '../../../../daemon/questions/lib/rendered-form.ts';

/** M7: Claude's own question form, read off the screen alone — and nothing else read as one. */
const text = await fixtureTexts(join(import.meta.dir, '../../../fixtures/question-forms'));
const screen = (visible: string) => questionScreen(visible, visible);

describe('readOpenForm', () => {
  it('reads a single question drawn with its header chip', () => {
    const form = readOpenForm(screen(text('claude-2.1.281-single-80x24.txt')));
    expect(form?.header).toBe('Pool check');
    expect(form?.question).toStartWith('Test 4c collapsed, and the next test depends on');
    expect(form?.question).toEndWith('How should we find out?');
    expect(form?.multiple).toBe(false);
    // The free-form row is Claude's, not an option; the description is the indented text under the label.
    expect(form?.options.map(option => option.label)).toEqual([
      'Read one prod pod (Recommended)',
      "I'll check Vault",
      'Skip; test with jitter',
    ]);
    expect(form?.options[1]?.description).toStartWith('You look in Vault');
  });

  it('reads a multi-select question behind a one-tab strip', () => {
    const form = readOpenForm(screen(text('claude-2.1.281-single-multiselect.txt')));
    expect(form).toEqual({
      header: 'Extras',
      question: 'Which extras should ship?',
      options: [
        { label: 'Shadow', description: 'Adds a drop shadow.' },
        { label: 'Border', description: 'Adds a thin border.' },
      ],
      multiple: true,
    });
  });

  it('reads only the visible tab of a several-question form, with no header', () => {
    const form = readOpenForm(screen(text('claude-2.1.281-multi-q1.txt')));
    expect(form?.header).toBeUndefined();
    expect(form?.question).toBe('Which colour should the banner use?');
    expect(form?.options.map(option => option.label)).toEqual(['Red', 'Blue']);
  });

  it('reads nothing from an ordinary numbered list in the pane', () => {
    const plan = [
      '⏺ Here is the plan:',
      '',
      '  1. Read the config',
      '  2. Change the flag',
      '  3. Run the tests',
      '',
      '❯ ',
      '──────────────────────────────────────────────────────────────────────────────',
      '  ? for shortcuts',
    ].join('\n');
    expect(readOpenForm(screen(plan))).toBeUndefined();
    // Even with a selection marker on a row, a list without the form's top and footer is not a form.
    expect(readOpenForm(screen(plan.replace('  1. Read', '❯ 1. Read')))).toBeUndefined();
  });

  it('reads nothing from a form whose footer is missing (a permission prompt shares the rows)', () => {
    const drawn = text('claude-2.1.281-single-80x24.txt').replace(/Enter to select[^\n]*/u, 'Esc to cancel');
    expect(readOpenForm(screen(drawn))).toBeUndefined();
  });

  it('reads nothing once the form is gone (the answered form leaves only scrollback)', () => {
    const gone = `${text('claude-2.1.281-single-80x24.txt')}\n\n⏺ You chose option 1.\n\n❯ \n\n  ? for shortcuts\n`;
    const visible = `⏺ You chose option 1.\n\n❯ \n\n  ? for shortcuts\n`;
    expect(readOpenForm(questionScreen(visible, gone))).toBeUndefined();
  });
});
