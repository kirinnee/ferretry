import {
  bindQuestionForm,
  bindReviewPage,
  boundQuestionIndex,
  formFrame,
  formHeaderShows,
  type QuestionScreen,
  type RenderedQuestion,
  screenShowsQuestion,
} from './rendered-form.ts';

/**
 * EVERY NATIVE INPUT IS BOUND TO THE FORM IT WAS MEANT FOR.
 *
 * A key typed into a pane lands on whatever the pane shows at that instant. The question lane can say the stored question
 * is still pending, but the native surface moves on its own: a permission prompt, a dialog or the next question can replace
 * the form while the stored question has not changed. So the driver names, for each key and paste, the surface it expects
 * and where it expects the cursor, and this file decides — from a FRESH read of the pane taken immediately before the
 * input — whether the pane still shows exactly that. If it does not, nothing is typed.
 *
 * The same rule as a permission answer: a key moves a cursor only on a form that is positively the one asked about, and
 * Enter (any key) needs EXACTLY ONE cursor, read on the row expected. A new blocking prompt is never evidence that an
 * answer landed.
 */
export type InputExpectation =
  | {
      readonly kind: 'question';
      /** Which pending question's form the pane must show. */
      readonly index: number;
      /** How many numbered rows that form had when it was bound. */
      readonly rows?: number | undefined;
      /** The row the cursor must be on, when the drive has moved it there itself. */
      readonly cursor?: number | undefined;
      /** Text has been typed into the form's free-form row: its row is no longer its option text, so only the header binds. */
      readonly typed?: boolean | undefined;
    }
  | {
      readonly kind: 'review';
      readonly cursor?: number | undefined;
    }
  /** The release Escape: any of the pending questions' forms, or their review page, with one cursor read. */
  | { readonly kind: 'cancel' }
  /** A free-form page opened by Enter on a plain `Other` row: the question's text, and no numbered form of anything else. */
  | { readonly kind: 'page'; readonly index: number };

/** Why an input was refused. Only `cursor-moved` can heal by itself (a redraw that has not arrived yet). */
type InputRefusal = 'unbound' | 'cursor-missing' | 'cursor-moved';

export interface InputRefusalDetail {
  readonly refusal: InputRefusal;
  readonly message: string;
}

/** `undefined` when the screen is exactly what the input expects; otherwise why not. */
export function refuseInput(
  screen: QuestionScreen,
  questions: readonly RenderedQuestion[],
  expect: InputExpectation,
): InputRefusalDetail | undefined {
  const unbound = (what: string): InputRefusalDetail => ({
    refusal: 'unbound',
    message: `the pane no longer shows ${what}; nothing further was typed`,
  });
  const frame = formFrame(screen);
  if (expect.kind === 'page') {
    const question = questions[expect.index];
    if (question === undefined || frame !== undefined || !screenShowsQuestion(screen, question.question))
      return unbound('the free-form page of the pending question');
    return undefined;
  }
  if (expect.kind === 'cancel') {
    if (
      !questions.some(question => bindQuestionForm(screen, question) !== undefined) &&
      bindReviewPage(screen, questions) === undefined
    )
      return unbound('a form of the pending questions');
  } else if (expect.kind === 'review') {
    if (bindReviewPage(screen, questions) === undefined) return unbound('the review page of the pending questions');
  } else {
    const question = questions[expect.index];
    if (question === undefined) return unbound('the pending question');
    const bound =
      expect.typed === true
        ? formHeaderShows(screen, question.question) && (expect.rows === undefined || frame?.rows === expect.rows)
        : bindQuestionForm(screen, question) !== undefined && boundQuestionIndex(screen, questions) === expect.index;
    if (!bound) return unbound('the form of the pending question');
  }
  if (frame === undefined || frame.cursors !== 1 || frame.cursor === undefined)
    return {
      refusal: 'cursor-missing',
      message: 'the form cursor is not visible exactly once; nothing further was typed',
    };
  if ('cursor' in expect && expect.cursor !== undefined && frame.cursor !== expect.cursor)
    return {
      refusal: 'cursor-moved',
      message: `the form cursor is on row ${frame.cursor + 1}, not the row ${expect.cursor + 1} expected; nothing further was typed`,
    };
  return undefined;
}
