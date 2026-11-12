import { describe, expect, it } from 'bun:test';
import { type InputExpectation, refuseInput } from '../../../../daemon/questions/lib/input-frame.ts';
import {
  bindQuestionForm,
  questionScreen,
  type RenderedQuestion,
  surfaceOf,
} from '../../../../daemon/questions/lib/rendered-form.ts';

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

const refusal = (visible: string, expect: InputExpectation, blocking?: 'permission' | 'dialog') =>
  refuseInput(questionScreen(visible, visible), questions, expect, blocking)?.refusal;

/** The surface the drive verified: the form as it is first drawn. */
const verified = surfaceOf(
  bindQuestionForm(
    questionScreen(claude('Deploy?', ['Yes', 'No', 'Other'], 0), claude('Deploy?', ['Yes', 'No', 'Other'], 0)),
    questions[0] as RenderedQuestion,
  ) as NonNullable<ReturnType<typeof bindQuestionForm>>,
);
const form: InputExpectation = { kind: 'question', index: 0, surface: verified, cursor: 0 };

/** A permission prompt that quotes the question and offers its options among others, as a real one can. */
const QUOTING = [
  RULE,
  'Bash command',
  '',
  '  printf Deploy?',
  '',
  'Do you want to proceed?',
  '  1. Yes',
  '❯ 2. Yes, and do not ask again',
  '  3. No',
].join('\n');

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
    expect(refusal(PERMISSION, { kind: 'question', index: 0, surface: verified, typed: { index: 2, text: 'x' } })).toBe(
      'unbound',
    );
  });

  it('never takes a pane the harness recognises as a permission prompt or dialog for the question form', () => {
    const shown = claude('Deploy?', ['Yes', 'No', 'Other'], 0);
    expect(refusal(shown, form, 'permission')).toBe('unbound');
    expect(refusal(shown, form, 'dialog')).toBe('unbound');
    expect(refusal(shown, { kind: 'cancel' }, 'permission')).toBe('unbound');
    expect(refuseInput(questionScreen(shown, shown), questions, form, 'permission')?.message).toMatch(
      /permission prompt, not the question/u,
    );
  });

  it('binds the COMPLETE surface: a prompt quoting the question with the same options among others is not the form', () => {
    expect(refusal(QUOTING, form)).toBe('unbound');
    expect(refusal(QUOTING, { ...form, cursor: 1 })).toBe('unbound');
    // Not for a key that moves between tabs, nor for the release Escape that follows nothing typed.
    expect(refusal(QUOTING, { kind: 'question', index: 0 })).toBe('unbound');
    expect(refusal(QUOTING, { kind: 'cancel' })).toBe('unbound');
  });

  it('refuses a form whose rows are the same options in another order or count', () => {
    expect(refusal(claude('Deploy?', ['No', 'Yes', 'Other'], 0), form)).toBe('unbound');
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other', 'Maybe'], 0), form)).toBe('unbound');
    expect(refusal(claude('Deploy?', ['Yes', 'No'], 0), form)).toBe('unbound');
  });

  it('lets a tab not yet seen be typed into only while it offers nothing but the question’s own rows', () => {
    const open: InputExpectation = { kind: 'question', index: 0 };
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Other'], 0), open)).toBeUndefined();
    expect(refusal(claude('Deploy?', ['Yes', 'No', 'Yes, and do not ask again'], 0), open)).toBe('unbound');
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
    const typed: InputExpectation = {
      kind: 'question',
      index: 0,
      surface: verified,
      cursor: 2,
      typed: { index: 2, text: 'Ask the on-call first' },
    };

    it('binds the typed row to the typed text, because that row now draws it', () => {
      const shown = claude('Deploy?', ['Yes', 'No', 'Ask the on-call first'], 2);
      expect(refusal(shown, { kind: 'question', index: 0, surface: verified, cursor: 2 })).toBe('unbound');
      expect(refusal(shown, typed)).toBeUndefined();
    });

    it('accepts a long typed answer the pane cut with an ellipsis, and refuses a different one', () => {
      expect(refusal(claude('Deploy?', ['Yes', 'No', 'Ask the on-…'], 2), typed)).toBeUndefined();
      expect(refusal(claude('Deploy?', ['Yes', 'No', 'Something else'], 2), typed)).toBe('unbound');
    });

    it('still refuses a permission prompt, a different row count, a changed other row and an unreadable cursor', () => {
      expect(refusal(PERMISSION, typed)).toBe('unbound');
      expect(refusal(QUOTING, typed)).toBe('unbound');
      expect(refusal(claude('Deploy?', ['Yes', 'No'], 1), typed)).toBe('unbound');
      expect(refusal(claude('Deploy?', ['Yes', 'Maybe', 'Ask the on-call first'], 2), typed)).toBe('unbound');
      expect(refusal(claude('Deploy?', ['Yes', 'No', 'Ask the on-call first'], []), typed)).toBe('cursor-missing');
    });
  });

  describe('the release Escape follows what the drive last typed into', () => {
    const typedLast: Extract<InputExpectation, { kind: 'question' }> = {
      kind: 'question',
      index: 0,
      surface: verified,
      cursor: 2,
      typed: { index: 2, text: 'Ask the on-call first' },
    };

    it('is allowed on that surface and refused on anything else, a quoting prompt included', () => {
      const shown = claude('Deploy?', ['Yes', 'No', 'Ask the on-call first'], 2);
      expect(refusal(shown, { kind: 'cancel', last: typedLast })).toBeUndefined();
      expect(refusal(QUOTING, { kind: 'cancel', last: typedLast })).toBe('unbound');
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

    it('is not an unnumbered dialog that quotes the question, nor a page lacking the entry line', () => {
      const dialog = [RULE, 'New MCP server found in this project: Deploy?', '', '  Use this server', '  Skip it'].join(
        '\n',
      );
      expect(refusal(dialog, page)).toBe('unbound');
      expect(refusal([RULE, 'Deploy?', ''].join('\n'), page)).toBe('unbound');
      expect(refusal([RULE, 'Deploy?', '', 'Type your answer: █', 'Enter to continue'].join('\n'), page)).toBe(
        'unbound',
      );
    });

    it('needs the pasted text drawn on its entry line before the Enter that sends it', () => {
      const typed: InputExpectation = { kind: 'page', index: 0, typed: 'later' };
      expect(refusal([RULE, 'Deploy?', '', 'Type your answer: later█'].join('\n'), typed)).toBeUndefined();
      expect(refusal([RULE, 'Deploy?', '', 'Type your answer: █'].join('\n'), typed)).toBe('unbound');
      expect(refusal([RULE, 'Deploy?', '', 'Type your answer: other'].join('\n'), typed)).toBe('unbound');
    });
  });
});
