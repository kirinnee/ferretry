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
  isQuestionScopedRequestId,
  RELOAD_THE_APP,
  answerPaused,
} from '../lib/answer-wording.ts';
import { StructuredAnswerCoordinator } from '../lib/coordinator.ts';
import { SessionAnswerError } from '../lib/mounts/session-answer.ts';
import {
  StructuredQuestionAttemptFailed,
  StructuredQuestionAttemptPaused,
  type StructuredQuestionFailureContext,
  StructuredQuestionRefused,
  StructuredQuestionService,
} from '../lib/service.ts';
import { FORM_OFF, harnessFormPane } from './harness-form-pane.ts';
import { HarnessQuestionDriver } from './harness-question-driver.ts';
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

const PROTECTED: ReadonlySet<SessionStatus> = new Set(['completed', 'stopped', 'failed', 'kill_failed']);

/** The question as the structured-answer domain reads it (`question.json` holds exactly one question). */
function pendingOf(question: Question): PendingQuestion {
  return {
    toolUseId: question.toolUseId,
    questions: [
      {
        question: question.text,
        ...(question.header === undefined ? {} : { header: question.header }),
        options: question.options.map(({ label, description }) =>
          description === undefined ? { label } : { label, description },
        ),
        multiSelect: question.multiple,
      },
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

  const driver = new HarnessQuestionDriver(
    pane,
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
          if (!read.ok || read.value?.toolUseId !== toolUseId)
            throw new SessionAnswerError('refused', `question ${toolUseId} is no longer pending; it was not cleared`);
          // The stamp first: it is the proof reconciliation defers to, so a crash before the clear still reads answered.
          await state.write(QUESTION_ANSWERED_STATE, { format: 1, toolUseId, answeredAt: clock.now() }, key(id));
          await state.remove(QUESTION_STATE, key(id));
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
      cancel: async (id, question) => await driver.cancel(id, question),
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
