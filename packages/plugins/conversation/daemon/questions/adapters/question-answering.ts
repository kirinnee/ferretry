import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { StatePort } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { type Question, QUESTION_ANSWERED_STATE, QUESTION_STATE } from '../../../contract/index.ts';
import { ApiError } from '../../seams/api.ts';
import { type SessionId, tryParseSessionId } from '../../seams/ferret-id.ts';
import type { SessionStatus } from '../../seams/ferret-types.ts';
import type { ClockPort, SerialExecutor } from '../../seams/ports.ts';
import type { PendingQuestion, SessionView, StructuredQuestionAnswer } from '../../seams/protocol.ts';
import {
  AnswerAcknowledged,
  AnswerAlreadyAnswered,
  AnswerReleased,
  AnswerRequestConflict,
  AnswerTerminalFailure,
  AnswerToolAlreadyHandled,
  AnswerUnconfirmed,
  type QuestionDocument,
} from '../lib/answer-ledger.ts';
import {
  ANSWER_MAY_HAVE_LANDED,
  ANSWER_NOT_DELIVERED,
  FORM_UNREADABLE,
  isQuestionScopedRequestId,
  RELOAD_THE_APP,
  answerPaused,
} from '../lib/answer-wording.ts';
import { StructuredAnswerCoordinator } from '../lib/coordinator.ts';
import { type InputExpectation, refuseInput } from '../lib/input-frame.ts';
import { questionScreen } from '../lib/rendered-form.ts';
import { SessionAnswerError } from '../lib/mounts/session-answer.ts';
import {
  StructuredQuestionAttemptFailed,
  StructuredQuestionAttemptPaused,
  StructuredQuestionAttemptUnreadable,
  type StructuredQuestionFailureContext,
  StructuredQuestionRefused,
  StructuredQuestionService,
} from '../lib/service.ts';
import { FORM_OFF, harnessFormPane } from './harness-form-pane.ts';
import {
  HarnessQuestionDriver,
  StructuredQuestionDriveError,
  type StructuredQuestionPane,
} from './harness-question-driver.ts';
import { StateAnswerLedger } from './state-answer-ledger.ts';
import { clearAskedQuestion, type QuestionLane } from './state-asked-question.ts';

/** What the answer path needs of the daemon. Everything is a port, so the real composition and a test wire it alike. */
export interface QuestionAnsweringDeps {
  readonly state: StatePort;
  readonly ferrets: Pick<FerretsApi, 'get' | 'harness'>;
  /** The ferret's `question.json` lane (the writer's, the clear's and the withdrawal's), shared with them. */
  readonly questionLane: QuestionLane;
  /** This path's OWN queue (never the storage executor's: the clear re-enters it, see the coordinator). */
  readonly serial: SerialExecutor;
  readonly clock: ClockPort;
  /** A ferret's lifecycle state as a session status; `undefined` for a ferret Ferrets does not know. */
  readonly status: (ferret: SessionId) => Promise<SessionStatus | undefined>;
  /** `conversation.question-answered`, published once the answer is durable. */
  readonly publishAnswered: (ferret: SessionId, toolUseId: string) => Promise<void>;
  /** Ids and codes only: a pane, a question's text and an answer are never logged. */
  readonly log: {
    info(event: string, fields?: Readonly<Record<string, string | number | boolean>>): void;
    warn(message: string): void;
  };
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly polls?: number;
  readonly pollMs?: number;
}

/** The request one answer arrives as (the route's, plus who is calling). */
export interface QuestionAnswerRequest {
  readonly toolUseId: string;
  readonly labels: readonly string[];
  readonly other?: string | undefined;
  readonly responses?: readonly string[] | undefined;
  readonly answers?: readonly StructuredQuestionAnswer[] | undefined;
  readonly requestId: string;
  readonly caller?: string | undefined;
}

/**
 * The last surface a drive was allowed to type into, per attempt (the same `PendingQuestion` object reaches the drive and
 * the release that follows it), so the release Escape is bound to what the drive last saw rather than to any form that
 * shares the question's text.
 */
const lastTyped = new WeakMap<PendingQuestion, Extract<InputExpectation, { readonly kind: 'question' }>>();

const PROTECTED: ReadonlySet<SessionStatus> = new Set(['completed', 'stopped', 'failed', 'kill_failed']);

/** The question as the structured-answer domain reads it: the first question and, for a tabbed form, the ones after it. */
function pendingOf(question: Question): PendingQuestion {
  const item = (
    text: string,
    header: string | undefined,
    options: Question['options'],
    multiple: boolean,
  ): PendingQuestion['questions'][number] => ({
    question: text,
    ...(header === undefined ? {} : { header }),
    options: options.map(({ label, description }) => (description === undefined ? { label } : { label, description })),
    multiSelect: multiple,
  });
  return {
    toolUseId: question.toolUseId,
    questions: [
      item(question.text, question.header, question.options, question.multiple),
      ...(question.more ?? []).map(more => item(more.text, more.header, more.options, more.multiple)),
    ],
    askedAt: question.askedAt as Instant,
  };
}

/**
 * ANSWERING A QUESTION'S FORM (v4's `fyd.ts` wiring of `StructuredQuestionService`, over 5.0's state).
 *
 * The domain is the ported one, unchanged: the service binds the stored question, the driver types into the live form
 * only after it has positively bound it on a captured frame (and refuses rather than guesses when the layout drifts),
 * the coordinator makes one logical answer drive at most once, and the ledger remembers which request did.
 *
 * What is 5.0's own: the pending question is `question.json`; every key and paste goes through the ferret's
 * `FerretHarness.form`, whose runner holds them under `kernel.act(<pane>, 'keys')`; and the commit point of an answer is
 * `question-answered.json` (the stamp) followed by the exact-id clear of `question.json`, both in the ferret's question
 * lane, so a crash between them leaves the answer provable and a newer question is never cleared.
 *
 * ACCESS comes first and is Ferrets' rule: a ferret caller reaches `ferrets.harness(id, caller)`, which refuses (403) one
 * that may not touch the target, before the ledger, the state or a pane is read. A person (no caller) is not asked.
 */
export function buildQuestionAnswering(deps: QuestionAnsweringDeps) {
  const { state, ferrets, questionLane, clock } = deps;
  const pane = harnessFormPane(ferrets);
  const key = (id: SessionId): string => String(id);

  /**
   * A DRIVE IS BOUND TO ITS QUESTION, NOT TO A PANE. The service checks the tool id once, before the drive, but a
   * question update or a withdrawal runs on another lane, and the pane cannot tell two forms with the same text apart. So
   * every key and paste of a drive first asks, IN the ferret's question lane and in the same step as the input itself,
   * whether `question.json` still holds this exact tool id; if it does not (replaced by a newer question, or withdrawn)
   * nothing is typed. A writer cannot land a newer question between the check and the key, and the lane is held for one
   * key only, never across the drive (the answered stamp and the failure release take it too).
   *
   * A DRIVE IS ALSO BOUND TO THE NATIVE FORM, FRAME BY FRAME. The stored question says nothing about what the pane shows
   * now: a permission prompt, a dialog or the next question can replace the form while `question.json` is unchanged, and
   * a key typed then is a key typed into that prompt. So in the same step, and before every key and paste, the pane is
   * read again through the form seam and must still be the expected surface of THIS question (its form or review page,
   * the free-form page it opened), with exactly one cursor read on the row the drive expects. Otherwise nothing is typed.
   * The reading is of the pane after any earlier key, so a prompt that arrives between two keys stops the second.
   * (A redraw that has not yet caught up with the last arrow is waited out; anything else refuses at once.)
   *
   * Captures are reads and are not bound: a form that is already answered, retired by the watch, or replaced by the next
   * question is still read to confirm the answer; only input is refused.
   */
  const boundPane = (pending: PendingQuestion): StructuredQuestionPane => {
    const toolUseId = pending.toolUseId;
    const polls = deps.polls ?? 12;
    const pollMs = deps.pollMs ?? 250;
    const formStillShown = async (ferret: string, expect: InputExpectation): Promise<void> => {
      for (let poll = 0; ; poll++) {
        const shown = await pane.state(ferret);
        if (!shown.alive || shown.dead)
          throw new StructuredQuestionDriveError(
            'session pane is dead; nothing further was typed into the form',
            'none',
            { phase: 'input-binding', reason: 'pane-dead' },
          );
        const refusal = refuseInput(
          questionScreen(shown.visible, shown.history),
          pending.questions,
          expect.kind === 'cancel' ? { kind: 'cancel', last: lastTyped.get(pending) } : expect,
          shown.blocking,
        );
        if (refusal === undefined) {
          if (expect.kind === 'question') lastTyped.set(pending, expect);
          return;
        }
        // Only a cursor that is still where the last arrow was heading may heal; a replaced or unreadable form never does.
        if (refusal.refusal !== 'cursor-moved' || poll >= polls)
          throw new StructuredQuestionDriveError(refusal.message, 'none', {
            phase: 'input-binding',
            reason: refusal.refusal === 'cursor-missing' ? 'cursor-missing' : 'input-unbound',
          });
        await deps.sleep(pollMs);
      }
    };
    const typeIfHeld = async <T>(ferret: string, expect: InputExpectation, input: () => Promise<T>): Promise<T> =>
      await questionLane.run(ferret, async () => {
        const read = await state.read(QUESTION_STATE, ferret);
        if (!read.ok)
          throw new StructuredQuestionDriveError(
            'question state is unreadable; nothing further was typed into the form',
            'none',
            { phase: 'question-binding', reason: 'state-unreadable' },
          );
        if (read.value?.toolUseId !== toolUseId)
          throw new StructuredQuestionDriveError(
            `question ${toolUseId} is no longer the pending question (${read.value === undefined ? 'it was withdrawn' : 'it was replaced'}); nothing further was typed into the form`,
            'none',
            {
              phase: 'question-binding',
              reason: read.value === undefined ? 'question-withdrawn' : 'question-replaced',
            },
          );
        await formStillShown(ferret, expect);
        return await input();
      });
    return {
      state: async ferret => await pane.state(ferret),
      // The watch's own stamp for this question, else the transcript's result for it (see the form pane).
      completed: async (ferret, id) => {
        const stamp = await state.read(QUESTION_ANSWERED_STATE, ferret);
        return (stamp.ok && stamp.value?.toolUseId === id) || (await pane.completed?.(ferret, id)) === true;
      },
      sendKey: async (ferret, pressed, expect: InputExpectation) =>
        await typeIfHeld(ferret, expect, async () => await pane.sendKey(ferret, pressed)),
      paste: async (ferret, text, expect: InputExpectation) =>
        await typeIfHeld(ferret, expect, async () => await pane.paste(ferret, text)),
    };
  };

  /** One driver per question: it types through the question's own bound pane. It keeps no other state. */
  const driverFor = (pending: PendingQuestion): HarnessQuestionDriver =>
    new HarnessQuestionDriver(
      boundPane(pending),
      async id => key(id),
      deps.sleep,
      deps.polls,
      deps.pollMs,
      async (id, step) => {
        // The step names only where the drive is: `shown` is the review page's text, which is an answer.
        deps.log.info('question.answer_step', {
          ferret: key(id),
          step: step.step,
          ...('questionIndex' in step ? { questionIndex: step.questionIndex } : {}),
        });
      },
    );
  const driver = {
    drive: async (id: SessionId, question: PendingQuestion, answers: readonly StructuredQuestionAnswer[]) =>
      await driverFor(question).drive(id, question, answers),
  };

  const diagnostics = (context: StructuredQuestionFailureContext) => ({
    acceptance: context.failure.acceptance,
    ...(typeof context.failure.diagnostics.phase === 'string' ? { phase: context.failure.diagnostics.phase } : {}),
    ...(typeof context.failure.diagnostics.reason === 'string' ? { reason: context.failure.diagnostics.reason } : {}),
  });

  const service = new StructuredQuestionService(
    {
      pending: async id => {
        const status = await deps.status(id);
        if (status !== undefined && PROTECTED.has(status))
          throw new StructuredQuestionRefused(
            status === 'kill_failed'
              ? `the previous terminal shutdown for ${id} was not confirmed; stop it successfully before answering`
              : `session ${id} is ${status}; a terminal session cannot accept a structured answer`,
          );
        const read = await state.read(QUESTION_STATE, key(id));
        if (!read.ok)
          throw new SessionAnswerError(
            'failed',
            `session ${id} question state is unreadable; it cannot be treated as no question`,
          );
        return read.value === undefined ? undefined : pendingOf(read.value);
      },
      answered: async (id, toolUseId, answers, confirmation) => {
        await questionLane.run(key(id), async () => {
          const read = await state.read(QUESTION_STATE, key(id));
          // Unreadable is missing evidence: whether a newer question is stored cannot be told, so nothing is cleared.
          if (!read.ok)
            throw new SessionAnswerError('refused', `question ${toolUseId} state is unreadable; it was not cleared`);
          // The form visibly advanced, so the answer is stamped even when the watch has already retired this question
          // (the transcript said the call was over) or the next one has replaced it: the stamp is the proof of what
          // landed. The stamp first: reconciliation defers to it, so a crash before the clear still reads answered.
          await state.write(QUESTION_ANSWERED_STATE, { format: 1, toolUseId, answeredAt: clock.now() }, key(id));
          // Only this exact question is cleared; a newer one the hook has stored since is its own.
          if (read.value?.toolUseId === toolUseId) await state.remove(QUESTION_STATE, key(id));
        });
        deps.log.info('question.answered', {
          ferret: key(id),
          confirmation: confirmation.confirmedBy,
          answerCount: answers.length,
        });
        // The stamp is the commit point; an event that cannot be published never turns it into a failure.
        await deps
          .publishAnswered(id, toolUseId)
          .catch(error =>
            deps.log.warn(`conversation could not publish question-answered for ${id}: ${String(error)}`),
          );
      },
      // The form stays pending exactly as it is; only the stop and how far it got are recorded.
      paused: async (id, question, answers, context) => {
        deps.log.info('question.answer_paused', {
          ferret: key(id),
          toolUseId: question.toolUseId,
          stoppedAt: context.failure.progress.stoppedAt,
          answerCount: answers.length,
          ...diagnostics(context),
        });
      },
      retained: async (id, question, answers, context) => {
        deps.log.info('question.answer_retained', {
          ferret: key(id),
          toolUseId: question.toolUseId,
          answerCount: answers.length,
          ...diagnostics(context),
        });
      },
      // Called only after the exact form's cancellation was positively observed (an unconfirmed Escape is `retained`).
      failed: async (id, question, answers, context) => {
        // Only the exact tool id whose drive failed is released; a newer question owns itself.
        await clearAskedQuestion(state, questionLane, key(id), question.toolUseId);
        deps.log.info('question.answer_failed', {
          ferret: key(id),
          toolUseId: question.toolUseId,
          answerCount: answers.length,
          ...diagnostics(context),
        });
      },
    },
    driver,
    {
      // The frame is the form's own evidence: handed to the service for its decision, never stored or logged.
      snapshot: async id => await pane.state(key(id)),
      // The Escape is an input too: it is bound to this question, so a newer one's form is never cancelled by it.
      cancel: async (id, question) => await driverFor(question).cancel(id, question),
    },
  );

  const documentOf = async (id: SessionId): Promise<QuestionDocument | undefined> => {
    const asked = await state.read(QUESTION_STATE, key(id));
    const stamp = await state.read(QUESTION_ANSWERED_STATE, key(id));
    // An unreadable file is missing evidence, never evidence of absence (the coordinator quarantines on `undefined`).
    if (!asked.ok || !stamp.ok) return undefined;
    return {
      status: (await deps.status(id)) ?? 'awaiting_user',
      pendingQuestion: asked.value === undefined ? null : pendingOf(asked.value),
      ...(stamp.value === undefined ? {} : { lastAnsweredQuestionToolUseId: stamp.value.toolUseId }),
    };
  };

  const coordinator = new StructuredAnswerCoordinator({
    service,
    ledger: new StateAnswerLedger(state, clock),
    serial: deps.serial,
    clock,
    state: async id => (await documentOf(id)) as never,
    // RE-READ, never cached: the outcome is that the form is settled; the view is derived state that keeps moving.
    view: async id => {
      const summary = await ferrets.get(id);
      const status = await deps.status(id);
      if (summary === undefined || status === undefined)
        throw new SessionAnswerError('failed', `session ${id} answer was confirmed but its record is unreadable`);
      return { id, status, turn: 0, health: 'idle' } as SessionView;
    },
    // The form was positively released but nobody can say whether the answer landed: the question goes (prose may
    // continue) and the unsettled receipt stays in the ledger as the durable warning.
    quarantine: async (id, record) => {
      await clearAskedQuestion(state, questionLane, key(id), record.toolUseId).catch(() => undefined);
      deps.log.info('question.answer_unconfirmed', { ferret: key(id), toolUseId: record.toolUseId });
    },
  });

  /** The caller may touch this ferret, else 403 (Ferrets' `mayTouch`); a ferret Ferrets does not know is 404. */
  const open = async (reference: string, caller: string | undefined): Promise<SessionId> => {
    const id = tryParseSessionId(reference);
    if (id === undefined)
      throw new SessionAnswerError('invalid', `${JSON.stringify(reference)} is not a usable session id`);
    const callerId = caller === undefined ? undefined : tryParseSessionId(caller);
    if (caller !== undefined && callerId === undefined)
      throw new ApiError(403, 'the calling ferret is not known', 'forbidden');
    // Before the ledger, the state or a pane: a seam that is off types nothing and keeps no receipt that would block a retry.
    if (ferrets.harness === undefined) throw new ApiError(503, FORM_OFF, 'plugin_unavailable');
    const harness = await ferrets.harness(id, callerId);
    if (harness === undefined) throw new SessionAnswerError('not_found', `no session ${reference}`);
    if (harness.form === undefined) throw new ApiError(503, FORM_OFF, 'plugin_unavailable');
    return id;
  };

  return {
    async answer(reference: string, request: QuestionAnswerRequest): Promise<SessionView> {
      const id = await open(reference, request.caller);
      return await coordinator
        .answer({
          id,
          requestId: request.requestId,
          request: {
            toolUseId: request.toolUseId,
            labels: request.labels,
            ...(request.other === undefined ? {} : { other: request.other }),
            ...(request.responses === undefined ? {} : { responses: request.responses }),
            ...(request.answers === undefined ? {} : { answers: request.answers }),
          },
        })
        .catch((error: unknown) => {
          // Three different next actions, so three different refusals: fix the request, use a fresh id, or go and look
          // at the session. Collapsing them would tell a caller to retry in the one case where retrying must not happen.
          if (error instanceof StructuredQuestionRefused) throw new SessionAnswerError('refused', error.message);
          if (error instanceof AnswerRequestConflict)
            throw new SessionAnswerError(
              'conflict',
              isQuestionScopedRequestId(request.requestId)
                ? RELOAD_THE_APP
                : 'A different answer was already sent for this question. Reload the session and check it before answering again.',
              undefined,
              error.message,
            );
          if (error instanceof AnswerAlreadyAnswered)
            throw new SessionAnswerError('already_answered', error.message, error.answeredWith, error.detail);
          if (error instanceof AnswerToolAlreadyHandled) throw new SessionAnswerError('refused', error.message);
          if (error instanceof AnswerUnconfirmed)
            throw new SessionAnswerError('unconfirmed', ANSWER_MAY_HAVE_LANDED, undefined, error.message);
          if (
            error instanceof AnswerAcknowledged ||
            error instanceof AnswerReleased ||
            error instanceof AnswerTerminalFailure
          )
            throw new SessionAnswerError('released', error.message);
          // The driver's sentences are evidence, not instructions: they travel as the detail, and the person is told
          // how they can still answer.
          if (error instanceof StructuredQuestionAttemptPaused)
            throw new SessionAnswerError(
              'paused',
              answerPaused(error.failure.progress),
              undefined,
              error.message,
              error.failure.progress,
            );
          if (error instanceof StructuredQuestionAttemptUnreadable)
            throw new SessionAnswerError('unreadable', FORM_UNREADABLE, undefined, error.message, error.progress);
          if (error instanceof StructuredQuestionAttemptFailed) {
            if (error.receipt === 'accepted')
              throw new SessionAnswerError('unconfirmed', ANSWER_NOT_DELIVERED, undefined, error.message);
            if (error.receipt === 'failed' || error.receipt === 'quarantined')
              throw new SessionAnswerError('released', ANSWER_NOT_DELIVERED, undefined, error.message);
            throw new SessionAnswerError('failed', ANSWER_NOT_DELIVERED, undefined, error.message);
          }
          if (error instanceof SessionAnswerError || error instanceof ApiError) throw error;
          throw new SessionAnswerError('failed', error instanceof Error ? error.message : String(error));
        });
    },
  };
}
