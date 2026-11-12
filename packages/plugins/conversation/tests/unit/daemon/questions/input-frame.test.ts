import { describe, expect, it } from 'bun:test';
import { type InputExpectation, refuseInput } from '../../../../daemon/questions/lib/input-frame.ts';
import { questionScreen, type RenderedQuestion } from '../../../../daemon/questions/lib/rendered-form.ts';

const RULE = '─'.repeat(40);

/** A form drawn the way Claude Code draws one: a border, the question, numbered rows. */
function claude(question: string, rows: readonly string[], cursor: number | readonly number[] = 0): string {
  const at = typeof cursor === 'number' ? [cursor] : cursor;
  const drawn = rows.map((row, index) => `${at.includes(index) ? '❯' : ' '} ${index + 1}. ${row}`);
  return [RULE, question, '', ...drawn, RULE, `  ${rows.length + 1}. Chat about this`].join('\n');
}

const PERMISSION = [
  'Bash command',
  '  rm -rf /work/data',
  'Do you want to proceed?',
  '❯ 1. Yes',
  '  2. Yes, and do not ask again',
  '  3. No',
].join('\n');

const questions: readonly RenderedQuestion[] = [
  { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }, { label: 'Other' }] },
];

const refusal = (visible: string, expect: InputExpectation) =>
  refuseInput(questionScreen(visible, visible), questions, expect)?.refusal;

const form: InputExpectation = { kind: 'question', index: 0, rows: 3, cursor: 0 };

describe('the input boundary: a key goes only to the form it was meant for', () => {
  it('lets a key through on the exact question form with its one cursor where the drive expects it', () => {
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], 0), form)).toBeUndefined();
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], 1), { ...form, cursor: 1 })).toBeUndefined();
  });

  it('refuses a permission prompt that replaced the form, whatever cursor it shows', () => {
    expect(refusal(PERMISSION, form)).toBe('unbound');
    expect(refusal(PERMISSION, { ...form, cursor: undefined })).toBe('unbound');
    expect(refusal(PERMISSION, { kind: 'cancel' })).toBe('unbound');
    expect(refusal(PERMISSION, { kind: 'review' })).toBe('unbound');
    expect(refusal(PERMISSION, { kind: 'question', index: 0, typed: true, rows: 3 })).toBe('unbound');
  });

  it('refuses another question’s form, and a pane that shows no form at all', () => {
    expect(refusal(claude('Ship it?', ['Yes', 'No', 'Other'], 0), form)).toBe('unbound');
    expect(refusal('> ', form)).toBe('unbound');
  });

  it('needs EXACTLY ONE cursor: none and two are both an unknown selection', () => {
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], []), form)).toBe('cursor-missing');
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], [0, 1]), form)).toBe('cursor-missing');
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], []), { kind: 'cancel' })).toBe('cursor-missing');
  });

  it('reports a cursor that is not where the drive left it as moved, which is the only refusal a redraw can heal', () => {
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], 0), { ...form, cursor: 1 })).toBe('cursor-moved');
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], 2), form)).toBe('cursor-moved');
  });

  it('binds the escape that releases a form to any pending form, with its cursor read', () => {
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], 1), { kind: 'cancel' })).toBeUndefined();
  });

  describe('once text is typed into the free-form row', () => {
    const typed: InputExpectation = { kind: 'question', index: 0, rows: 3, cursor: 2, typed: true };

    it('binds by the header and the row count, because that row now holds the typed text', () => {
      const shown = claude('Deploy?', ['Yes', 'No', 'Ask the on-call first'], 2);
      expect(refusal(shown, { kind: 'question', index: 0, rows: 3, cursor: 2 })).toBe('unbound');
      expect(refusal(shown, typed)).toBeUndefined();
    });

    it('still refuses a permission prompt, a different row count and an unreadable cursor', () => {
      expect(refusal(PERMISSION, typed)).toBe('unbound');
      expect(refusal(claude('Deploy?', ['Yes', 'No'], 1), typed)).toBe('unbound');
      expect(refusal(claude('Deploy?', ['Yes', 'No', 'Ask the on-call first'], []), typed)).toBe('cursor-missing');
    });
  });

  describe('the free-form page that Enter on a plain Other row opens', () => {
    const page: InputExpectation = { kind: 'page', index: 0 };

    it('is the question’s text with no numbered form of its own', () => {
      expect(refusal([RULE, 'Deploy?', '', 'Type your answer: █'].join('\n'), page)).toBeUndefined();
    });

    it('is never a permission prompt, nor a screen that does not name the question', () => {
      expect(refusal(PERMISSION, page)).toBe('unbound');
      expect(refusal('> ', page)).toBe('unbound');
    });
  });
});
