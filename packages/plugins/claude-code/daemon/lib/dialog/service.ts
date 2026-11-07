import type { HarnessDialog, HarnessDialogAnswerRequest, HarnessDialogAnswerResult } from '../../contract/index.ts';
import { DIALOG_KEYS, dialogCursorMoves, parseHarnessDialog } from '../pane/harness-dialog.ts';
import type { FerretPane } from '../permission/service.ts';

/**
 * ANSWERING A HARNESS'S OWN DIALOG FOR A PERSON WHO IS NOT AT THE TERMINAL.
 *
 * The same three guarantees as a permission answer (`../permission/service.ts`), with one more step,
 * because a dialog is answered by Enter on a row rather than by a digit:
 *
 *   1. THE DIALOG IS RE-READ FIRST. If the pane no longer shows the very dialog the person saw
 *      (`dialogId`), nothing is typed and the caller is told it is gone.
 *   2. THE CURSOR IS MOVED, THEN CHECKED, THEN ENTER. Arrows put the cursor on the chosen row; the pane
 *      is read until it shows the same dialog with the cursor THERE, and only then is Enter pressed. A
 *      cursor that did not arrive is reported and Enter is never pressed on the wrong row.
 *   3. THE PANE SAYS WHETHER IT WORKED. After Enter (or Esc) the pane is read until the dialog is gone.
 *
 * Answers to one ferret are taken one at a time. Nothing here answers by itself: every key is a
 * person's choice, carried by a governed route.
 */

/** The live frame and the keyboard of a ferret's own pane — the permission answer's, shared. */
export type FerretDialogPane = FerretPane;

/** Why an answer was refused before Enter or Esc was sent. */
export type DialogAnswerRefusal = 'gone' | 'invalid_choice';

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

  private async read(ferretId: string): Promise<HarnessDialog | undefined> {
    return parseHarnessDialog(await this.pane.capture(ferretId).catch(() => ''));
  }

  private async type(ferretId: string, keys: string): Promise<void> {
    await this.pane.write(ferretId, new TextEncoder().encode(keys));
  }

  /** Reads the pane until `done` holds of what it shows; answers whether it did, and what it showed last. */
  private async until(
    ferretId: string,
    done: (shown: HarnessDialog | undefined) => boolean,
  ): Promise<{ readonly met: boolean; readonly last: HarnessDialog | undefined }> {
    let last: HarnessDialog | undefined;
    for (let read = 0; read < this.timing.settleReads; read += 1) {
      await this.sleep(this.timing.settleMs);
      last = await this.read(ferretId);
      if (done(last)) return { met: true, last };
    }
    return { met: false, last };
  }

  private async answerNow(ferretId: string, answer: HarnessDialogAnswerRequest): Promise<HarnessDialogAnswerResult> {
    const shown = parseHarnessDialog(await this.pane.capture(ferretId));
    if (shown?.id !== answer.dialogId) throw new DialogAnswerError('gone', GONE, shown);
    const gone = (after: HarnessDialog | undefined): boolean => after?.id !== answer.dialogId;
    if (answer.kind === 'escape') {
      if (shown.escape === undefined) throw new DialogAnswerError('invalid_choice', 'this dialog offers no Esc', shown);
      await this.type(ferretId, DIALOG_KEYS.escape);
      return { dialogId: answer.dialogId, cleared: (await this.until(ferretId, gone)).met };
    }
    const moves = dialogCursorMoves(shown, answer.number);
    if (moves === undefined)
      throw new DialogAnswerError('invalid_choice', `the dialog has no choice ${answer.number}`, shown);
    if (moves !== '') {
      await this.type(ferretId, moves);
      const moved = await this.until(ferretId, after => gone(after) || after?.selected === answer.number);
      // Another screen came up while the cursor moved: nothing was confirmed, and Enter is not pressed.
      if (moved.met && gone(moved.last)) throw new DialogAnswerError('gone', GONE, moved.last);
      if (!moved.met) return { dialogId: answer.dialogId, cleared: false };
    }
    await this.type(ferretId, DIALOG_KEYS.enter);
    return { dialogId: answer.dialogId, cleared: (await this.until(ferretId, gone)).met };
  }
}
