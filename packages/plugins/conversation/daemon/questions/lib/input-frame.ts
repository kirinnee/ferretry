import {
  bindReviewPage,
  boundQuestionIndex,
  type FormSurface,
  formFrame,
  formHeaderShows,
  freeFormPageShown,
  type QuestionScreen,
  type RenderedQuestion,
  showsOnlyKnownRows,
  surfaceStillShown,
  type TypedRow,
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
 * FIRST WHAT KIND OF SURFACE IT IS, THEN WHICH FORM. A pane the harness's own recognisers read as a permission prompt or a
 * dialog (`blocking`, decided by the runner that owns those readers) is never a question form, whatever text it shares
 * with one. Only then is the pane compared with the COMPLETE surface the drive verified: the same ordered rows, the same
 * free-form and Submit rows, the cursor where the drive left it and, after a paste, the typed text on its row. Text or
 * option overlap binds nothing.
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
      /**
       * Every row of the form as it was verified. Absent only for a tab whose rows were not seen beforehand (a Left from
       * the review page): then the form must offer nothing but the question's own options and its free-form row.
       */
      readonly surface?: FormSurface | undefined;
      /** The row the cursor must be on, when the drive has moved it there itself. */
      readonly cursor?: number | undefined;
      /** Text pasted into the inline free-form row: that one row must now draw it. */
      readonly typed?: TypedRow | undefined;
      /**
       * Only with no `surface`: the answer this drive typed on that tab earlier (the review page listed it). The tab now
       * draws it, marked `✔`, in place of its free-form row, and that one row is known.
       */
      readonly held?: string | undefined;
    }
  | {
      readonly kind: 'review';
      readonly cursor?: number | undefined;
    }
  /**
   * The release Escape: any of the pending questions' forms, or their review page, with one cursor read. Escape is an
   * input like any other — on a permission prompt it DENIES — so a form counts only as the surface the drive last typed
   * into (`last`, when it typed at all) or, with nothing typed yet, one that offers nothing but the question's own rows.
   */
  | { readonly kind: 'cancel'; readonly last?: Extract<InputExpectation, { readonly kind: 'question' }> | undefined }
  /**
   * The free-form page Enter on a plain `Other` row opens, positively read ({@link freeFormPageShown}): the question as its
   * whole heading and one entry line, nothing else. `typed` is the text already pasted into it, which the entry line must draw.
   */
  | { readonly kind: 'page'; readonly index: number; readonly typed?: string | undefined };

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
  /** What the runner's permission and dialog readers say the pane is: set, the pane is not a question form. */
  blocking?: 'permission' | 'dialog' | undefined,
): InputRefusalDetail | undefined {
  const unbound = (what: string): InputRefusalDetail => ({
    refusal: 'unbound',
    message: `the pane no longer shows ${what}; nothing further was typed`,
  });
  if (blocking !== undefined)
    return {
      refusal: 'unbound',
      message: `the pane is showing a ${blocking === 'permission' ? 'permission prompt' : 'dialog'}, not the question; nothing further was typed`,
    };
  const frame = formFrame(screen);
  if (expect.kind === 'page') {
    const question = questions[expect.index];
    if (question === undefined || frame !== undefined || !freeFormPageShown(screen, question, expect.typed))
      return unbound('the free-form page of the pending question');
    return undefined;
  }
  if (expect.kind === 'cancel') {
    const last = expect.last;
    const formShown = questions.some((question, index) =>
      last?.surface !== undefined && last.index === index
        ? surfaceStillShown(screen, question, last.surface, last.typed)
        : showsOnlyKnownRows(screen, question),
    );
    if (!formShown && bindReviewPage(screen, questions) === undefined)
      return unbound('a form of the pending questions');
  } else if (expect.kind === 'review') {
    if (bindReviewPage(screen, questions) === undefined) return unbound('the review page of the pending questions');
  } else {
    const question = questions[expect.index];
    if (question === undefined) return unbound('the pending question');
    const shown =
      expect.surface === undefined
        ? showsOnlyKnownRows(screen, question, expect.held)
        : surfaceStillShown(screen, question, expect.surface, expect.typed);
    // The longer question wins when one question's text contains another's; typed text hides no header. A held row is
    // known only by the text the drive verified it against.
    const held = expect.surface?.held ?? expect.held;
    const heldAt = questions.map((_, index) => (index === expect.index && held !== undefined ? [held] : []));
    const named =
      expect.typed === undefined
        ? boundQuestionIndex(screen, questions, heldAt) === expect.index
        : formHeaderShows(screen, question);
    if (!shown || !named) return unbound('the form of the pending question');
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
