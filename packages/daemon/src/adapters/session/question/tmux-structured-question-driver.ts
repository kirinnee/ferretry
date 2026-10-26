import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import {
  type BoundQuestionForm,
  bindQuestionForm,
  bindReviewPage,
  bindTabStrip,
  boundQuestionIndex,
  FREE_FORM_LABEL,
  type QuestionScreen,
  questionScreen,
  type RenderedQuestion,
  reviewShowsAnswer,
  screenShowsQuestion,
} from '../../../lib/session/question/rendered-form.ts';
import {
  type StructuredQuestionCancellation,
  StructuredQuestionDriveFailure,
  type StructuredQuestionDriveJournal,
  StructuredQuestionDrivePaused,
  type StructuredQuestionDriver,
  type StructuredQuestionDriveStep,
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

/** The two inputs a drive types, each marking that an answer may have reached the harness. */
interface Keys {
  readonly sendKey: (key: string) => Promise<void>;
  readonly paste: (text: string) => Promise<void>;
}

const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();
const screenOf = (pane: PaneState): QuestionScreen => questionScreen(pane.visible, pane.history);
/** Codex's footer once Tab has opened a note under its free-form row. */
const NOTES_OPEN = /tab or esc to clear notes/iu;
/** How many times one tab's answer is chosen before the drive stops rather than loop. */
const CHOICES_PER_TAB = 2;

/** Drives only a positively bound visible selector and waits for it to advance. */
export class TmuxStructuredQuestionDriver implements StructuredQuestionDriver {
  constructor(
    private readonly tmux: StructuredQuestionPane,
    private readonly session: (id: SessionId) => Promise<string>,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly polls = 12,
    private readonly pollMs = 250,
    private readonly journal: StructuredQuestionDriveJournal = async () => {},
  ) {}

  /**
   * Answer every pending question on the pane.
   *
   * A Claude form with a tab strip is driven tab by tab ({@link driveTabs}); anything else — a single
   * question, Codex's pages — page by page. A tabbed drive that stops before `Submit answers` leaves
   * the form open and says so with {@link StructuredQuestionDrivePaused}, because Escape would discard
   * every question already answered and nothing has been submitted yet.
   */
  async drive(
    id: SessionId,
    pending: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: Confirmation }> {
    let mayHaveAccepted = false;
    let tabbed = false;
    let submitting = false;
    let session: string | undefined;
    try {
      session = await this.session(id);
      const pane = session;
      const keys: Keys = {
        sendKey: async key => {
          // Set before awaiting tmux: a command that loses its response may still have delivered input.
          mayHaveAccepted = true;
          await this.tmux.sendKey(pane, key);
        },
        paste: async text => {
          mayHaveAccepted = true;
          await this.tmux.paste(pane, text);
        },
      };
      const first = await this.tmux.state(session);
      if (!first.alive || first.dead)
        throw new StructuredQuestionDriveError('session pane is dead; use resume', 'none', {
          phase: 'preflight',
          questionIndex: 0,
          paneAlive: first.alive,
          paneDead: first.dead,
        });
      const strip = bindTabStrip(screenOf(first), pending.questions);
      if (strip !== undefined) {
        tabbed = true;
        await this.step(id, { step: 'started', mode: 'tabs', answered: strip.answered });
        const confirmedBy = await this.driveTabs(id, session, pending, answers, first, keys, () => {
          submitting = true;
        });
        return { confirmedBy };
      }
      await this.step(id, { step: 'started', mode: 'pages' });
      return { confirmedBy: await this.drivePages(id, session, pending, answers, first, keys) };
    } catch (error) {
      const failure = settled(error, mayHaveAccepted);
      if (!tabbed || submitting || session === undefined) throw failure;
      throw (await this.pausedOn(session, pending, failure)) ?? failure;
    }
  }

  /** Page by page: each question is bound, answered, and proved to have moved on before the next. */
  private async drivePages(
    id: SessionId,
    session: string,
    pending: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    first: PaneState,
    keys: Keys,
  ): Promise<Confirmation> {
    let confirmation: Confirmation = 'pane-advanced';
    for (let index = 0; index < pending.questions.length; index++) {
      const question = pending.questions[index];
      const answer = answers[index];
      if (question === undefined || answer === undefined)
        throw new StructuredQuestionDriveError(`question ${index + 1} vanished before it could be driven`, 'none', {
          phase: 'preflight',
          questionIndex: index,
        });
      const before = index === 0 ? first : await this.tmux.state(session);
      if (!before.alive || before.dead)
        throw new StructuredQuestionDriveError('session pane is dead; use resume', 'none', {
          phase: 'preflight',
          questionIndex: index,
          paneAlive: before.alive,
          paneDead: before.dead,
        });
      const form = bindQuestionForm(screenOf(before), question);
      if (form === undefined)
        throw atQuestion(
          pending,
          index,
          new StructuredQuestionDriveError(
            'the rendered form is not the exact pending question; no keys were sent',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'question-unbound' },
          ),
        );
      await this.choose(session, pending, index, question, answer, form, keys);
      const last = index === pending.questions.length - 1;
      const advanced = await this.waitForAdvance(session, pending, index, before.visible, last);
      await this.step(id, { step: 'answered', questionIndex: index });
      if (advanced !== 'review') {
        confirmation = advanced;
        continue;
      }
      const review = await this.tmux.state(session);
      confirmation = await this.submitReview(session, pending, answers, review, keys.sendKey);
      await this.step(id, { step: 'submitted' });
    }
    return confirmation;
  }

  /**
   * Tab by tab, from whichever tab the form is on — so a form already part-answered, in the Console
   * or by a drive that stopped, is finished rather than refused.
   *
   * Each step reads the pane once and acts on what it shows:
   *   - a question tab: choose the requested answer (or, if the tab is already ticked with exactly that
   *     answer, pass over it with →), then prove its tab is ticked and the form moved on;
   *   - the review page: if every tab is ticked and the page lists exactly the requested answers, choose
   *     `Submit answers`; otherwise go back with ← to the first tab that disagrees.
   * `Submit answers` is the one key that finishes the form, and it is pressed only on that proof.
   */
  private async driveTabs(
    id: SessionId,
    session: string,
    pending: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    first: PaneState,
    keys: Keys,
    submitting: () => void,
  ): Promise<Confirmation> {
    const total = pending.questions.length;
    const chosen = pending.questions.map(() => 0);
    let state = first;
    let at = 0;
    for (let step = 0; step < total * 6 + 4; step++) {
      if (step > 0) state = await this.livePane(session, 'pane died while driving the question tabs');
      const screen = screenOf(state);
      const review = bindReviewPage(screen, pending.questions);
      const answered = bindTabStrip(screen, pending.questions)?.answered ?? review?.shown.map(shown => !!shown);
      if (answered === undefined)
        throw atQuestion(
          pending,
          at,
          new StructuredQuestionDriveError('the question tabs are no longer on screen', 'none', {
            phase: 'drive',
            reason: 'tabs-unbound',
          }),
        );
      if (review !== undefined) {
        const wrong = pending.questions.findIndex(
          (question, index) =>
            answered[index] !== true || !reviewShowsAnswer(review.shown[index], question, answers[index] ?? none),
        );
        if (wrong < 0) {
          await this.step(id, { step: 'review-verified' });
          submitting();
          const confirmation = await this.submitReview(session, pending, answers, state, keys.sendKey);
          await this.step(id, { step: 'submitted' });
          return confirmation;
        }
        at = wrong;
        await this.step(id, { step: 'revisited', questionIndex: wrong, shown: review.shown[wrong] });
        // The review is the tab after the last question.
        for (let move = 0; move < total - wrong; move++) await keys.sendKey('Left');
        await this.waitForTab(
          session,
          pane => boundQuestionIndex(screenOf(pane), pending.questions) === wrong,
          atQuestion(pending, wrong, new StructuredQuestionDriveError('← did not bring its tab back')),
        );
        continue;
      }
      const current = boundQuestionIndex(screen, pending.questions);
      const question = current === undefined ? undefined : pending.questions[current];
      const answer = current === undefined ? undefined : answers[current];
      if (current === undefined || question === undefined || answer === undefined)
        throw atQuestion(
          pending,
          Math.max(0, answered.indexOf(false)),
          new StructuredQuestionDriveError(
            'the tab on screen is not one of the pending questions; no keys were sent to it',
            'none',
            { phase: 'drive', reason: 'question-unbound' },
          ),
        );
      at = current;
      const form = bindQuestionForm(screen, question) as BoundQuestionForm;
      const moved = (pane: PaneState): boolean => {
        const next = screenOf(pane);
        const ticked = bindTabStrip(next, pending.questions)?.answered[current] === true;
        return (
          bindReviewPage(next, pending.questions) !== undefined ||
          (ticked && boundQuestionIndex(next, pending.questions) !== current)
        );
      };
      if (answered[current] === true && keeps(form, question, answer)) {
        await keys.sendKey('Right');
        await this.waitForTab(
          session,
          moved,
          atQuestion(pending, current, new StructuredQuestionDriveError('→ did not move past its tab')),
        );
        await this.step(id, { step: 'kept', questionIndex: current });
        continue;
      }
      // Text typed into this tab earlier replaced its `Type something.` row; pasting would append to it.
      if (answer.kind === 'other' && form.freeForm === undefined && form.chosen !== undefined)
        throw atQuestion(
          pending,
          current,
          new StructuredQuestionDriveError(
            `it already holds the typed answer «${form.labels[form.chosen]}», which is not replaced automatically; change it in the terminal`,
            'none',
            { phase: 'drive', reason: 'typed-answer-held' },
          ),
        );
      chosen[current] = (chosen[current] ?? 0) + 1;
      if ((chosen[current] ?? 0) > CHOICES_PER_TAB)
        throw atQuestion(
          pending,
          current,
          new StructuredQuestionDriveError(`its answer was chosen ${CHOICES_PER_TAB} times and did not hold`, 'none', {
            phase: 'drive',
            reason: 'answer-not-held',
          }),
        );
      await this.choose(session, pending, current, question, answer, form, keys);
      await this.waitForTab(
        session,
        moved,
        atQuestion(
          pending,
          current,
          new StructuredQuestionDriveError(
            'the answer keys were sent, but its tab was not ticked and the form did not move on',
          ),
        ),
      );
      await this.step(id, { step: 'answered', questionIndex: current });
    }
    throw atQuestion(
      pending,
      at,
      new StructuredQuestionDriveError('the form did not reach a review page listing the requested answers', 'none', {
        phase: 'drive',
        reason: 'steps-exhausted',
      }),
    );
  }

  /** Type one question's answer into its bound form: the keys the harness takes for that kind. */
  private async choose(
    session: string,
    pending: PendingQuestion,
    index: number,
    question: RenderedQuestion,
    answer: StructuredQuestionAnswer,
    form: BoundQuestionForm,
    keys: Keys,
  ): Promise<void> {
    if (form.cursor === undefined)
      throw atQuestion(
        pending,
        index,
        new StructuredQuestionDriveError(
          'the form cursor is not visible; a selection origin cannot be guessed',
          'none',
          { phase: 'preflight', questionIndex: index, reason: 'cursor-missing' },
        ),
      );
    const choices = answer.kind === 'selection' ? answer.labels.map(compact) : [FREE_FORM_LABEL];
    if (choices.some(label => !form.labels.includes(label)))
      throw atQuestion(
        pending,
        index,
        new StructuredQuestionDriveError('the requested answer is not an option in the bound rendered form', 'none', {
          phase: 'preflight',
          questionIndex: index,
          reason: 'choice-missing',
        }),
      );
    let at = form.cursor;
    const moveTo = async (target: number): Promise<void> => {
      const key = target >= at ? 'Down' : 'Up';
      for (let step = 0; step < Math.abs(target - at); step++) await keys.sendKey(key);
      at = target;
    };
    if (answer.kind === 'other') {
      await this.enterFreeForm(session, question, form, answer.text, moveTo, keys);
      return;
    }
    if (question.multiSelect === true) {
      // Toggle exactly the rows whose box disagrees with the answer: Claude's Enter toggles a row
      // rather than finishing the page, so the page is finished from its own Submit row.
      for (const [row, label] of form.labels.entries()) {
        if (choices.includes(label) === (form.checked[row] ?? false)) continue;
        await moveTo(row);
        await keys.sendKey('Space');
      }
      if (form.submit !== undefined) await moveTo(form.submit);
      await keys.sendKey('Enter');
      return;
    }
    await moveTo(form.labels.indexOf(choices[0] ?? ''));
    await keys.sendKey('Enter');
  }

  /**
   * The failure a stopped tabbed drive becomes when its form is still open: paused, with which tabs are
   * ticked — or `undefined` when the pane no longer shows the form, and the failure stands as it is.
   */
  private async pausedOn(
    session: string,
    pending: PendingQuestion,
    failure: StructuredQuestionDriveFailure,
  ): Promise<StructuredQuestionDrivePaused | undefined> {
    const pane = await this.tmux.state(session).catch(() => undefined);
    if (pane === undefined || !pane.alive || pane.dead) return undefined;
    const answered = bindTabStrip(screenOf(pane), pending.questions)?.answered;
    if (answered === undefined) return undefined;
    const index = failure.diagnostics.questionIndex;
    const stoppedAt = typeof index === 'number' ? index : Math.max(0, answered.indexOf(false));
    return new StructuredQuestionDrivePaused(
      failure.message,
      { stoppedAt, answered },
      failure.acceptance,
      failure.diagnostics,
    );
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
    keys: Keys,
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
      await keys.sendKey('Enter');
      await this.waitForScreen(
        session,
        pane => pane.visible !== opened && screenShowsQuestion(screenOf(pane), question.question),
        'selecting Other did not produce a bound free-form page',
      );
      await keys.paste(text);
      await keys.sendKey('Enter');
      return;
    }
    if (free.entry === 'notes') {
      await keys.sendKey('Tab');
      await this.waitForScreen(
        session,
        pane => NOTES_OPEN.test(pane.visible),
        'Tab did not open a note under the free-form row',
      );
    }
    await keys.paste(text);
    if (question.multiSelect === true && form.submit !== undefined) await moveTo(form.submit);
    await keys.sendKey('Enter');
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

  /** Poll until a tab move shows, or throw `failure`; a dead pane is its own failure. */
  private async waitForTab(
    session: string,
    ready: (pane: PaneState) => boolean,
    failure: StructuredQuestionDriveFailure,
  ): Promise<void> {
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      if (ready(await this.livePane(session, 'session pane died while confirming the structured answer'))) return;
    }
    throw failure;
  }

  private async livePane(session: string, died: string): Promise<PaneState> {
    const state = await this.tmux.state(session);
    if (!state.alive || state.dead) throw new StructuredQuestionDriveError(died);
    return state;
  }

  private async step(id: SessionId, step: StructuredQuestionDriveStep): Promise<void> {
    await this.journal(id, step).catch(() => undefined);
  }

  /**
   * Finish Claude's closing review page: choose `Submit answers`, then prove the page went away.
   *
   * Pressed only when the page lists exactly the requested answer for every question: whatever was
   * typed into the form — by this drive, an earlier one, or a person in the Console — is what Claude
   * receives, so it is read back before it is sent.
   */
  private async submitReview(
    session: string,
    pending: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    state: PaneState,
    sendKey: (key: string) => Promise<void>,
  ): Promise<Confirmation> {
    const review = bindReviewPage(screenOf(state), pending.questions);
    if (review?.cursor === undefined)
      throw new StructuredQuestionDriveError('the answers reached a review page whose cursor is not visible');
    const wrong = pending.questions.findIndex(
      (question, index) => !reviewShowsAnswer(review.shown[index], question, answers[index] ?? none),
    );
    if (wrong >= 0)
      throw atQuestion(
        pending,
        wrong,
        new StructuredQuestionDriveError(
          `the review page lists «${review.shown[wrong] ?? 'no answer'}», not the requested answer; Submit answers was not pressed`,
          'none',
          { phase: 'review', reason: 'review-mismatch' },
        ),
      );
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

/** Stands in for an answer the request did not carry, which no review page can list. */
const none: StructuredQuestionAnswer = { kind: 'other', text: '' };

/**
 * Whether a ticked tab already holds exactly this answer, so → may pass over it. Text typed into a
 * tab is drawn in place of its `Type something.` row, marked `✔` like a chosen row.
 */
function keeps(form: BoundQuestionForm, question: RenderedQuestion, answer: StructuredQuestionAnswer): boolean {
  const wanted = answer.kind === 'other' ? [compact(answer.text)] : answer.labels.map(compact);
  if (question.multiSelect === true && answer.kind === 'selection')
    return form.labels.every((label, row) => wanted.includes(label) === (form.checked[row] ?? false));
  return form.chosen !== undefined && form.labels[form.chosen] === wanted[0];
}

/**
 * Name the question a multi-question drive stopped at, ahead of why: "stopped at question 3 of 4
 * (Meet&Greet): …". A single question needs no such prefix.
 */
function atQuestion(
  pending: PendingQuestion,
  index: number,
  failure: StructuredQuestionDriveFailure,
): StructuredQuestionDriveFailure {
  const total = pending.questions.length;
  if (total < 2) return failure;
  const header = pending.questions[index]?.header;
  return new StructuredQuestionDriveError(
    `stopped at question ${index + 1} of ${total}${header === undefined ? '' : ` (${header})`}: ${failure.message}`,
    failure.acceptance,
    { phase: 'drive', ...failure.diagnostics, questionIndex: index },
  );
}

/** A failure as the caller must see it: any failure after the first key may have reached the form. */
function settled(error: unknown, mayHaveAccepted: boolean): StructuredQuestionDriveFailure {
  if (error instanceof StructuredQuestionDriveFailure) {
    if (!mayHaveAccepted || error.acceptance === 'ambiguous') return error;
    return new StructuredQuestionDriveError(error.message, 'ambiguous', error.diagnostics);
  }
  return new StructuredQuestionDriveError(
    error instanceof Error ? error.message : String(error),
    mayHaveAccepted ? 'ambiguous' : 'none',
    { phase: mayHaveAccepted ? 'drive' : 'preflight' },
  );
}
