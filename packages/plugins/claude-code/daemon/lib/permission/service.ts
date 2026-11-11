import type { FormKey } from '@ferretry/core-ferrets/contract';
import type { PermissionAnswerRequest, PermissionAnswerResult, PermissionRequest } from '../../../contract/index.ts';
import { parsePermissionPrompt, permissionAnswerKeys, recordedPermissionId } from '../pane/permission-prompt.ts';

/**
 * ANSWERING A HARNESS PERMISSION PROMPT FOR A PERSON WHO IS NOT AT THE TERMINAL.
 *
 * A person saw one prompt — `requestId` names it — and picked a choice. Three things make that safe:
 *
 *   1. THE PROMPT IS RE-READ FIRST. The pane is captured and parsed again right before the key goes in;
 *      if it no longer shows that very request (answered at the terminal, replaced by the next one,
 *      gone with the turn), nothing is typed and the caller is told the prompt is gone. A key meant for
 *      one prompt never lands on another.
 *   2. THE CURSOR IS MOVED, THEN CHECKED, THEN ENTER. EVERY Enter — the zero-move one too — needs exactly one cursor row
 *      positively read on the chosen row; no marker, or two, is an unknown selection and refuses ("cursor_unknown"). Arrows put the cursor on the chosen row; the pane is read
 *      until it shows the same prompt with the cursor THERE, and only then is Enter pressed (see
 *      {@link permissionAnswerKeys}). A cursor that did not arrive is reported and Enter is never pressed on the wrong
 *      row. A refusal is Escape alone.
 *   3. THE PANE SAYS WHETHER IT WORKED. After the confirming key the pane is read until the prompt is gone, and
 *      the answer reports what it saw. A prompt still up is reported, never answered twice.
 *
 * THE PANE IS THE FERRET'S OWN, REACHED THROUGH FERRETS. Every read and every key is Ferrets' form seam on the ferret's
 * runner-owned pane (`FerretHarness.form`), for either harness and for a pane that was already running before this daemon
 * started: nothing here names a tmux pane, and a Vault hold types nothing.
 *
 * Answers to one ferret are taken one at a time, so two devices answering at once cannot both pass
 * the re-read before either key lands. This never answers anything by itself: every key here is a
 * person's choice, carried by a governed route.
 */

/** The live frame and the keyboard of a ferret's own pane, as its runner owns it (Ferrets' form seam). */
export interface FerretPane {
  /** The visible frame, as text (masked by the runner before it leaves). */
  capture(ferretId: string): Promise<string>;
  /** Presses one key of the closed form set. Rejects when nothing was pressed. */
  key(ferretId: string, key: FormKey): Promise<void>;
}

/** Why an answer was refused before any key was sent. */
export type PermissionAnswerRefusal = 'gone' | 'invalid_choice' | 'cursor_unknown';

export class PermissionAnswerError extends Error {
  constructor(
    readonly refusal: PermissionAnswerRefusal,
    message: string,
    /** What the pane shows instead, when it shows a prompt at all. */
    readonly current?: PermissionRequest | undefined,
  ) {
    super(message);
    this.name = 'PermissionAnswerError';
  }
}

export interface PermissionAnswerTiming {
  /** How many times the pane is re-read after the key before the prompt is called still up. */
  readonly settleReads: number;
  readonly settleMs: number;
}

const CURSOR_UNKNOWN =
  'the prompt does not show which choice is selected, so nothing was sent: answer it at the terminal';

const DEFAULT_TIMING: PermissionAnswerTiming = { settleReads: 15, settleMs: 200 };

export class PermissionAnswerService {
  private readonly queue = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pane: FerretPane,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly timing: PermissionAnswerTiming = DEFAULT_TIMING,
  ) {}

  /** Answers the prompt `answer.requestId` names, if — and only if — the pane still shows it. */
  async answer(ferretId: string, answer: PermissionAnswerRequest): Promise<PermissionAnswerResult> {
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

  private async answerNow(ferretId: string, answer: PermissionAnswerRequest): Promise<PermissionAnswerResult> {
    const shown = parsePermissionPrompt(await this.pane.capture(ferretId));
    // The id the card holds is the one Ferrets recorded off the same screen (the runner spells the harness its own way):
    // either names this prompt, and from here on the prompt is known by the id this plugin reads.
    const wanted =
      shown !== undefined && (answer.requestId === shown.id || answer.requestId === recordedPermissionId(shown))
        ? shown.id
        : answer.requestId;
    if (shown?.id !== wanted)
      throw new PermissionAnswerError(
        'gone',
        'this prompt is gone: the agent’s screen no longer shows it, so nothing was sent',
        shown,
      );
    // Enter confirms whatever row the cursor is on, so a cursor that is not positively read (no marker, or two) refuses
    // before any key: it is not row 1, and arrows counted from a guess would land anywhere.
    if (
      answer.kind === 'choice' &&
      shown.selected === undefined &&
      shown.options.some(option => option.number === answer.number)
    )
      throw new PermissionAnswerError('cursor_unknown', CURSOR_UNKNOWN, shown);
    const keys = permissionAnswerKeys(shown, answer);
    if (keys === undefined)
      throw new PermissionAnswerError(
        'invalid_choice',
        `the prompt has no choice ${answer.kind === 'choice' ? answer.number : ''}`.trim(),
        shown,
      );
    const gone = (after: PermissionRequest | undefined): boolean => after?.id !== wanted;
    if (keys.moves.length > 0) {
      for (const key of keys.moves) await this.pane.key(ferretId, key);
      const target = answer.kind === 'choice' ? answer.number : undefined;
      const moved = await this.until(ferretId, after => gone(after) || after?.selected === target);
      // Another screen came up while the cursor moved: nothing was confirmed, and Enter is not pressed.
      if (moved.met && gone(moved.last))
        throw new PermissionAnswerError(
          'gone',
          'this prompt is gone: the agent’s screen no longer shows it, so nothing was confirmed',
          moved.last,
        );
      // Not met: the cursor never showed, once and alone, on the chosen row (a markerless redraw is not evidence). No Enter.
      if (!moved.met) return { requestId: answer.requestId, cleared: false };
    }
    await this.pane.key(ferretId, keys.confirm);
    return { requestId: answer.requestId, cleared: (await this.until(ferretId, gone)).met };
  }

  /** Reads the pane until `done` holds of what it shows; answers whether it did, and what it showed last. */
  private async until(
    ferretId: string,
    done: (shown: PermissionRequest | undefined) => boolean,
  ): Promise<{ readonly met: boolean; readonly last: PermissionRequest | undefined }> {
    let last: PermissionRequest | undefined;
    for (let read = 0; read < this.timing.settleReads; read += 1) {
      await this.sleep(this.timing.settleMs);
      last = parsePermissionPrompt(await this.pane.capture(ferretId).catch(() => ''));
      if (done(last)) return { met: true, last };
    }
    return { met: false, last };
  }
}
