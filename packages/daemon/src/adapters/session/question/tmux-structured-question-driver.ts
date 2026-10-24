import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import {
  type BoundQuestionForm,
  bindQuestionForm,
  bindReviewPage,
  FREE_FORM_LABEL,
  type QuestionScreen,
  questionScreen,
  type RenderedQuestion,
  screenShowsQuestion,
} from '../../../lib/session/question/rendered-form.ts';
import {
  type StructuredQuestionCancellation,
  StructuredQuestionDriveFailure,
  type StructuredQuestionDriver,
} from '../../../lib/session/question/service.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { PaneState } from '../../../lib/tmux/contracts.ts';
import { paneShowsActiveWork } from '../../../lib/tmux/pane.ts';

/** The narrow pane seam the structured answer driver needs from tmux. */
export interface StructuredQuestionPane {
  state(session: string): Promise<PaneState>;
  sendKey(session: string, key: string): Promise<void>;
  paste(session: string, text: string): Promise<void>;
}

export class StructuredQuestionDriveError extends StructuredQuestionDriveFailure {
  constructor(
    message: string,
    acceptance: 'none' | 'ambiguous' = 'none',
    diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, acceptance, diagnostics);
    this.name = 'StructuredQuestionDriveError';
  }
}

type Confirmation = 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced';

const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const screenOf = (pane: PaneState): QuestionScreen => questionScreen(pane.visible, pane.history);
/** Codex's footer once Tab has opened a note under its free-form row. */
const NOTES_OPEN = /tab or esc to clear notes/iu;

/** Drives only a positively bound visible selector and waits for it to advance. */
export class TmuxStructuredQuestionDriver implements StructuredQuestionDriver {
  constructor(
    private readonly tmux: StructuredQuestionPane,
    private readonly session: (id: SessionId) => Promise<string>,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly polls = 12,
    private readonly pollMs = 250,
  ) {}

  async drive(
    id: SessionId,
    pending: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: Confirmation }> {
    let mayHaveAccepted = false;
    try {
      const session = await this.session(id);
      const sendKey = async (key: string): Promise<void> => {
        // Set before awaiting tmux: a command that loses its response may still have delivered input.
        mayHaveAccepted = true;
        await this.tmux.sendKey(session, key);
      };
      const paste = async (text: string): Promise<void> => {
        mayHaveAccepted = true;
        await this.tmux.paste(session, text);
      };
      let confirmation: Confirmation = 'pane-advanced';
      for (let index = 0; index < pending.questions.length; index++) {
        const question = pending.questions[index];
        const answer = answers[index];
        if (question === undefined || answer === undefined)
          throw new StructuredQuestionDriveError(`question ${index + 1} vanished before it could be driven`, 'none', {
            phase: 'preflight',
            questionIndex: index,
          });
        const before = await this.tmux.state(session);
        if (!before.alive || before.dead)
          throw new StructuredQuestionDriveError('session pane is dead; use resume', 'none', {
            phase: 'preflight',
            questionIndex: index,
            paneAlive: before.alive,
            paneDead: before.dead,
          });
        const form = bindQuestionForm(screenOf(before), question);
        if (form === undefined)
          throw new StructuredQuestionDriveError(
            'the rendered form is not the exact pending question; no keys were sent',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'question-unbound' },
          );
        if (form.cursor === undefined)
          throw new StructuredQuestionDriveError(
            'the form cursor is not visible; a selection origin cannot be guessed',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'cursor-missing' },
          );
        const choices = answer.kind === 'selection' ? answer.labels.map(compact) : [FREE_FORM_LABEL];
        if (choices.some(label => !form.labels.includes(label)))
          throw new StructuredQuestionDriveError(
            'the requested answer is not an option in the bound rendered form',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'choice-missing' },
          );
        let at = form.cursor;
        const moveTo = async (target: number): Promise<void> => {
          const key = target >= at ? 'Down' : 'Up';
          for (let step = 0; step < Math.abs(target - at); step++) await sendKey(key);
          at = target;
        };
        if (answer.kind === 'other')
          await this.enterFreeForm(session, question, form, answer.text, moveTo, sendKey, paste);
        else if (question.multiSelect === true) {
          // Toggle exactly the rows whose box disagrees with the answer: Claude's Enter toggles a row
          // rather than finishing the page, so the page is finished from its own Submit row.
          for (const [row, label] of form.labels.entries()) {
            if (choices.includes(label) === (form.checked[row] ?? false)) continue;
            await moveTo(row);
            await sendKey('Space');
          }
          if (form.submit !== undefined) await moveTo(form.submit);
          await sendKey('Enter');
        } else {
          await moveTo(form.labels.indexOf(choices[0] ?? ''));
          await sendKey('Enter');
        }
        const last = index === pending.questions.length - 1;
        const advanced = await this.waitForAdvance(session, pending, index, before.visible, last);
        confirmation = advanced === 'review' ? await this.submitReview(session, pending, sendKey) : advanced;
      }
      return { confirmedBy: confirmation };
    } catch (error) {
      if (error instanceof StructuredQuestionDriveFailure) {
        if (!mayHaveAccepted || error.acceptance === 'ambiguous') throw error;
        throw new StructuredQuestionDriveError(error.message, 'ambiguous', error.diagnostics);
      }
      throw new StructuredQuestionDriveError(
        error instanceof Error ? error.message : String(error),
        mayHaveAccepted ? 'ambiguous' : 'none',
        { phase: mayHaveAccepted ? 'drive' : 'preflight' },
      );
    }
  }

  /** Best-effort release after a failed drive: positively bind, send one Escape, then prove advance. */
  async cancel(id: SessionId, pending: PendingQuestion): Promise<StructuredQuestionCancellation> {
    const session = await this.session(id);
    let current = await this.tmux.state(session);
    if (!current.alive || current.dead)
      throw new StructuredQuestionDriveError('session pane is dead; use resume', 'none', {
        phase: 'cancel-preflight',
      });
    const visible = (pane: PaneState): boolean => {
      const screen = screenOf(pane);
      return (
        pending.questions.some(question => bindQuestionForm(screen, question) !== undefined) ||
        bindReviewPage(screen, pending.questions) !== undefined
      );
    };
    const advanced = (
      pane: PaneState,
      allowActiveWork: boolean,
    ): StructuredQuestionCancellation['confirmedBy'] | undefined => {
      if (visible(pane)) return undefined;
      if (pane.promptReady) return 'prompt-ready';
      // Active-work text is meaningful only after this method positively bound the form and sent
      // Escape. Before that, the form's own "esc to interrupt" footer describes the blocked tool
      // call and is not evidence that the modal advanced.
      if (allowActiveWork && paneShowsActiveWork(pane.visible)) return 'turn-started';
      return undefined;
    };
    const already = advanced(current, false);
    if (already !== undefined) return { confirmedBy: 'already-advanced', pane: current };
    if (!visible(current))
      throw new StructuredQuestionDriveError(
        'the failed answer no longer has a positively bound question menu; refusing automatic Escape',
        'none',
        { phase: 'cancel-preflight', reason: 'question-unbound' },
      );
    const before = current.visible;
    // Exactly once. A failed tmux response is not permission to send another Escape.
    await this.tmux.sendKey(session, 'Escape');
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      current = await this.tmux.state(session);
      if (!current.alive || current.dead)
        throw new StructuredQuestionDriveError('session pane died while releasing the structured question', 'none', {
          phase: 'cancel-confirm',
        });
      const confirmation = advanced(current, true);
      if (confirmation !== undefined) return { confirmedBy: confirmation, pane: current };
      if (!visible(current) && current.visible !== before) return { confirmedBy: 'pane-advanced', pane: current };
    }
    throw new StructuredQuestionDriveError('Escape was sent, but the question pane did not visibly advance', 'none', {
      phase: 'cancel-confirm',
    });
  }

  /**
   * Type a free-form answer the way THIS harness takes one, read off the row it rendered:
   * Claude's row is its own text field, Codex's opens a note with Tab, and a plain `Other` row opens a
   * separate page that is bound again before any text reaches it.
   */
  private async enterFreeForm(
    session: string,
    question: RenderedQuestion,
    form: BoundQuestionForm,
    text: string,
    moveTo: (target: number) => Promise<void>,
    sendKey: (key: string) => Promise<void>,
    paste: (text: string) => Promise<void>,
  ): Promise<void> {
    const free = form.freeForm;
    if (free === undefined)
      throw new StructuredQuestionDriveError('the bound rendered form has no free-form row', 'none', {
        phase: 'preflight',
        reason: 'choice-missing',
      });
    await moveTo(free.index);
    if (free.entry === 'page') {
      const opened = (await this.tmux.state(session)).visible;
      await sendKey('Enter');
      await this.waitForScreen(
        session,
        pane => pane.visible !== opened && screenShowsQuestion(screenOf(pane), question.question),
        'selecting Other did not produce a bound free-form page',
      );
      await paste(text);
      await sendKey('Enter');
      return;
    }
    if (free.entry === 'notes') {
      await sendKey('Tab');
      await this.waitForScreen(
        session,
        pane => NOTES_OPEN.test(pane.visible),
        'Tab did not open a note under the free-form row',
      );
    }
    await paste(text);
    if (question.multiSelect === true && form.submit !== undefined) await moveTo(form.submit);
    await sendKey('Enter');
  }

  private async waitForScreen(session: string, ready: (pane: PaneState) => boolean, failure: string): Promise<void> {
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      const state = await this.tmux.state(session);
      if (!state.alive || state.dead)
        throw new StructuredQuestionDriveError('session pane died while opening free-form input');
      if (ready(state)) return;
    }
    throw new StructuredQuestionDriveError(failure);
  }

  /**
   * Finish Claude's closing review page: choose `Submit answers`, then prove the page went away.
   * Reached only after the LAST question advanced to a review naming every pending question.
   */
  private async submitReview(
    session: string,
    pending: PendingQuestion,
    sendKey: (key: string) => Promise<void>,
  ): Promise<Confirmation> {
    const state = await this.tmux.state(session);
    const review = bindReviewPage(screenOf(state), pending.questions);
    if (review?.cursor === undefined)
      throw new StructuredQuestionDriveError('the answers reached a review page whose cursor is not visible');
    const key = review.submit >= review.cursor ? 'Down' : 'Up';
    for (let step = 0; step < Math.abs(review.submit - review.cursor); step++) await sendKey(key);
    await sendKey('Enter');
    return await this.waitForAdvance(session, pending, pending.questions.length - 1, state.visible, false);
  }

  private waitForAdvance(
    session: string,
    pending: PendingQuestion,
    index: number,
    before: string,
    reviewMayFollow: false,
  ): Promise<Confirmation>;
  private waitForAdvance(
    session: string,
    pending: PendingQuestion,
    index: number,
    before: string,
    reviewMayFollow: boolean,
  ): Promise<Confirmation | 'review'>;
  /**
   * Prove the answered page moved on. A review page is returned as such only when it may follow — after
   * the LAST question — and is otherwise waited out, because a review is the form still owning the pane.
   */
  private async waitForAdvance(
    session: string,
    pending: PendingQuestion,
    index: number,
    before: string,
    reviewMayFollow: boolean,
  ): Promise<Confirmation | 'review'> {
    let reviewing = false;
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      const state = await this.tmux.state(session);
      if (!state.alive || state.dead)
        throw new StructuredQuestionDriveError('session pane died while confirming the structured answer');
      const screen = screenOf(state);
      const next = pending.questions[index + 1];
      if (next !== undefined && bindQuestionForm(screen, next) !== undefined) return 'next-question';
      reviewing = bindReviewPage(screen, pending.questions) !== undefined;
      // A review page is not an advance: the form still owns the pane until it is submitted.
      if (reviewing && reviewMayFollow) return 'review';
      if (reviewing) continue;
      const anyQuestion = pending.questions.some(question => bindQuestionForm(screen, question) !== undefined);
      if (!anyQuestion && paneShowsActiveWork(state.visible)) return 'turn-started';
      if (!anyQuestion && state.promptReady) return 'prompt-ready';
      if (!anyQuestion && state.visible !== before) return 'pane-advanced';
    }
    throw new StructuredQuestionDriveError(
      reviewing
        ? 'Submit answers was chosen, but the review page did not close'
        : 'the answer keys were sent, but the rendered form did not visibly advance',
    );
  }
}
