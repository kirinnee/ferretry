import type { FormKey } from '@ferretry/core-ferrets/contract';
import type { HarnessDialog, HarnessDialogAnswerRequest, HarnessDialogAnswerResult } from '../../../contract/index.ts';
import { dialogCursorMoves, type HarnessDialogFrame, readHarnessDialogFrame } from '../pane/harness-dialog.ts';
import type { FerretPane } from '../permission/service.ts';

/**
 * ANSWERING A HARNESS'S OWN DIALOG FOR A PERSON WHO IS NOT AT THE TERMINAL.
 *
 * The same three guarantees as a permission answer (`../permission/service.ts`), with one more step,
 * because a dialog is answered by Enter on a row rather than by a digit:
 *
 *   1. THE DIALOG IS RE-READ FIRST. If the pane no longer shows the very dialog the person saw
 *      (`dialogId`), nothing is typed and the caller is told it is gone. If it shows it but its cursor cannot be
 *      read (on no row, or on several), nothing is typed either, and the caller is told so — that is not "gone": the
 *      dialog is still up, and the way on is the terminal.
 *   2. THE CURSOR IS MOVED, THEN CHECKED, THEN ENTER. Arrows put the cursor on the chosen row; the pane
 *      is read until it shows the same dialog with the cursor THERE, and only then is Enter pressed. A
 *      cursor that did not arrive, or that can no longer be read, is reported and Enter is never pressed.
 *   3. THE PANE SAYS WHETHER IT WORKED. After Enter (or Esc) the pane is read until the dialog is gone.
 *
 * Answers to one ferret are taken one at a time. Nothing here answers by itself: every key is a
 * person's choice, carried by a governed route.
 */

/** The live frame and the keyboard of a ferret's own pane — the permission answer's, shared. */
export type FerretDialogPane = FerretPane;

/** Why an answer was refused before Enter or Esc was sent. */
export type DialogAnswerRefusal = 'gone' | 'invalid_choice' | 'cursor_unknown';

export class DialogAnswerError extends Error {
  constructor(
    readonly refusal: DialogAnswerRefusal,
    message: string,
    /** What the pane shows instead, when it shows a dialog at all. */
    readonly current?: HarnessDialog | undefined,
  ) {
    super(message);
    this.name = 'DialogAnswerError';
  }
}

export interface DialogAnswerTiming {
  /** How many times the pane is re-read after a key before the dialog is called unchanged. */
  readonly settleReads: number;
  readonly settleMs: number;
}

const DEFAULT_TIMING: DialogAnswerTiming = { settleReads: 15, settleMs: 200 };

const GONE = 'this dialog is gone: the agent’s screen no longer shows it, so nothing was sent';

/** What the owner is told when the dialog's selected row cannot be read: nothing was typed, and the terminal is the way on. */
const CURSOR_UNKNOWN =
  'the dialog could not be read safely (its selected row is not shown clearly), so nothing was sent: answer it at the terminal';

export class DialogAnswerService {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pane: FerretDialogPane,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly timing: DialogAnswerTiming = DEFAULT_TIMING,
  ) {}

  /** Answers the dialog `answer.dialogId` names, if — and only if — the pane still shows it. */
  async answer(ferretId: string, answer: HarnessDialogAnswerRequest): Promise<HarnessDialogAnswerResult> {
    const before = this.queue.get(ferretId) ?? Promise.resolve();
    const run = before.catch(() => undefined).then(async () => await this.answerNow(ferretId, answer));
    const settled = run.catch(() => undefined);
    this.queue.set(ferretId, settled);
    try {
      return await run;
    } finally {
      if (this.queue.get(ferretId) === settled) this.queue.delete(ferretId);
    }
  }

  private async read(ferretId: string): Promise<HarnessDialogFrame | undefined> {
    return readHarnessDialogFrame(await this.pane.capture(ferretId).catch(() => ''));
  }

  private async type(ferretId: string, ...keys: FormKey[]): Promise<void> {
    for (const key of keys) await this.pane.key(ferretId, key);
  }

  /** Reads the pane until `done` holds of what it shows; answers whether it did, and what it showed last. */
  private async until(
    ferretId: string,
    done: (shown: HarnessDialogFrame | undefined) => boolean,
  ): Promise<{ readonly met: boolean; readonly last: HarnessDialogFrame | undefined }> {
    let last: HarnessDialogFrame | undefined;
    for (let read = 0; read < this.timing.settleReads; read += 1) {
      await this.sleep(this.timing.settleMs);
      last = await this.read(ferretId);
      if (done(last)) return { met: true, last };
    }
    return { met: false, last };
  }

  private async answerNow(ferretId: string, answer: HarnessDialogAnswerRequest): Promise<HarnessDialogAnswerResult> {
    const frame = readHarnessDialogFrame(await this.pane.capture(ferretId));
    // Either id names this dialog: the one this plugin reads, or the one Ferrets recorded off the same screen.
    const named = frame?.names.includes(answer.dialogId) === true;
    const shown = frame?.dialog;
    if (frame === undefined || shown === undefined || !named) throw new DialogAnswerError('gone', GONE, shown);
    const wanted = shown.id;
    // Enter confirms whichever row the cursor is on, so a cursor that is not positively read (no marker, or two) refuses
    // before any key, whatever the answer: it is not row 1, and arrows counted from a guess would land anywhere.
    if (!frame.cursorRead) throw new DialogAnswerError('cursor_unknown', CURSOR_UNKNOWN, shown);
    // The same dialog by its names, not its first id: a frame with no cursor cannot say which harness drew it.
    const gone = (after: HarnessDialogFrame | undefined): boolean => after?.names.includes(wanted) !== true;
    if (answer.kind === 'escape') {
      if (shown.escape === undefined) throw new DialogAnswerError('invalid_choice', 'this dialog offers no Esc', shown);
      await this.type(ferretId, 'Escape');
      return { dialogId: answer.dialogId, cleared: (await this.until(ferretId, gone)).met };
    }
    const moves = dialogCursorMoves(shown, answer.number);
    if (moves === undefined)
      throw new DialogAnswerError('invalid_choice', `the dialog has no choice ${answer.number}`, shown);
    if (moves.length > 0) {
      await this.type(ferretId, ...moves);
      const moved = await this.until(ferretId, after => gone(after) || after?.dialog.selected === answer.number);
      // Another screen came up while the cursor moved: nothing was confirmed, and Enter is not pressed.
      if (moved.met && gone(moved.last)) throw new DialogAnswerError('gone', GONE, moved.last?.dialog);
      // The cursor never showed, once and alone, on the chosen row. Enter is not pressed. If the last redraw could not be
      // read, that is not "did not clear": the dialog is still up, and the owner is told to answer it at the terminal.
      if (!moved.met) {
        if (moved.last?.cursorRead === false)
          throw new DialogAnswerError('cursor_unknown', CURSOR_UNKNOWN, moved.last.dialog);
        return { dialogId: answer.dialogId, cleared: false };
      }
    }
    await this.type(ferretId, 'Enter');
    return { dialogId: answer.dialogId, cleared: (await this.until(ferretId, gone)).met };
  }
}
