import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';

export type StructuredQuestionAcceptance = 'none' | 'ambiguous';

/** A drive refusal that states whether any answer input may already have reached the harness. */
export class StructuredQuestionDriveFailure extends Error {
  constructor(
    message: string,
    readonly acceptance: StructuredQuestionAcceptance,
    readonly diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'StructuredQuestionDriveFailure';
  }
}

/** The receipt transition a failed attempt is allowed to make after recovery. */
export type StructuredQuestionFailureReceipt = 'accepted' | 'withdrawn' | 'failed' | 'quarantined';

/** A failed answer attempt, including whether its durable receipt may be settled. */
export class StructuredQuestionAttemptFailed extends Error {
  constructor(
    message: string,
    readonly receipt: StructuredQuestionFailureReceipt,
    readonly failure: StructuredQuestionDriveFailure,
  ) {
    super(message, { cause: failure });
    this.name = 'StructuredQuestionAttemptFailed';
  }
}

/** The pane evidence retained with a failed answer. */
export interface StructuredQuestionDiagnosticPane {
  readonly alive: boolean;
  readonly dead: boolean;
  readonly promptReady: boolean;
  readonly visible: string;
  readonly history: string;
}

export interface StructuredQuestionCancellation {
  readonly confirmedBy: 'already-advanced' | 'prompt-ready' | 'turn-started' | 'pane-advanced';
  readonly pane: StructuredQuestionDiagnosticPane;
}

export interface StructuredQuestionFailureContext {
  readonly failure: StructuredQuestionDriveFailure;
  /** Positive form-advance evidence from the drive when no Escape was needed. */
  readonly releaseConfirmedBy?: string | undefined;
  readonly snapshot?: StructuredQuestionDiagnosticPane | undefined;
  readonly snapshotError?: string | undefined;
  readonly cancellation?: StructuredQuestionCancellation | undefined;
  readonly cancellationError?: string | undefined;
}

/** A question answer must be driven into the rendered harness form, not sent as prose. */
export interface StructuredQuestionDriver {
  drive(
    id: SessionId,
    question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced' }>;
}

/** The durable state boundary.  The exact tool id is checked again under this boundary. */
export interface StructuredQuestionRepository {
  pending(id: SessionId): Promise<PendingQuestion | undefined>;
  answered(
    id: SessionId,
    toolUseId: string,
    answers: readonly StructuredQuestionAnswer[],
    confirmation: { readonly confirmedBy: string },
  ): Promise<void>;
  /** Releases the exact failed form from durable question state and records why. */
  failed(
    id: SessionId,
    question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    context: StructuredQuestionFailureContext,
  ): Promise<void>;
  /** Retains diagnostics for an unconfirmed release without clearing the exact pending binding. */
  retained(
    id: SessionId,
    question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    context: StructuredQuestionFailureContext,
  ): Promise<void>;
}

/** Live recovery actions, kept outside the repository because they address a terminal pane. */
export interface StructuredQuestionFailureRecovery {
  snapshot(id: SessionId): Promise<StructuredQuestionDiagnosticPane>;
  cancel(id: SessionId, question: PendingQuestion): Promise<StructuredQuestionCancellation>;
}

export class StructuredQuestionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredQuestionRefused';
  }
}

function legacyAnswers(
  question: PendingQuestion,
  labels: readonly string[],
  other: string | undefined,
  responses: readonly string[] | undefined,
): StructuredQuestionAnswer[] {
  if (responses !== undefined) {
    if (responses.length !== question.questions.length)
      throw new StructuredQuestionRefused(
        `expected ${question.questions.length} answers, received ${responses.length}`,
      );
    return responses.map((response, index) => {
      const item = question.questions[index];
      if (item === undefined) throw new StructuredQuestionRefused(`question ${index + 1} is not present`);
      return item.options?.some(option => option.label === response)
        ? { kind: 'selection' as const, labels: [response] }
        : { kind: 'other' as const, text: response.trim() };
    });
  }
  if (question.questions.length !== 1)
    throw new StructuredQuestionRefused('a question set requires one answer for every displayed question');
  return other === undefined ? [{ kind: 'selection', labels: [...labels] }] : [{ kind: 'other', text: other.trim() }];
}

function validate(question: PendingQuestion, answers: readonly StructuredQuestionAnswer[]): StructuredQuestionAnswer[] {
  if (answers.length !== question.questions.length)
    throw new StructuredQuestionRefused(`expected ${question.questions.length} answers, received ${answers.length}`);
  return answers.map((answer, index) => {
    const item = question.questions[index];
    if (item === undefined) throw new StructuredQuestionRefused(`question ${index + 1} is not present`);
    if (answer.kind === 'other') {
      if (answer.text.trim() === '')
        throw new StructuredQuestionRefused(`question ${index + 1} has an empty free-form answer`);
      return { kind: 'other', text: answer.text.trim() };
    }
    const labels = [...answer.labels];
    if (labels.length === 0) throw new StructuredQuestionRefused(`question ${index + 1} has no selected option`);
    if (new Set(labels).size !== labels.length)
      throw new StructuredQuestionRefused(`question ${index + 1} repeats an option`);
    if (item.multiSelect !== true && labels.length !== 1)
      throw new StructuredQuestionRefused(`question ${index + 1} accepts exactly one option`);
    const options = item.options ?? [];
    if (labels.some(label => !options.some(option => option.label === label)))
      throw new StructuredQuestionRefused(`question ${index + 1} names an option the rendered form did not offer`);
    return { kind: 'selection', labels };
  });
}

/**
 * Coordinates the only safe answer ordering: bind the stored question, drive the
 * live form, receive visible advance evidence, then clear the exact durable key.
 */
export class StructuredQuestionService {
  constructor(
    private readonly repository: StructuredQuestionRepository,
    private readonly driver: StructuredQuestionDriver,
    private readonly recovery: StructuredQuestionFailureRecovery,
  ) {}

  async answer(input: {
    readonly id: SessionId;
    readonly toolUseId: string;
    readonly labels: readonly string[];
    readonly other?: string | undefined;
    readonly responses?: readonly string[] | undefined;
    readonly answers?: readonly StructuredQuestionAnswer[] | undefined;
  }): Promise<void> {
    let pending: PendingQuestion | undefined;
    try {
      pending = await this.repository.pending(input.id);
    } catch (error) {
      // A repository may positively refuse a lifecycle state (notably `kill_failed`) before the
      // terminal is touched. Preserve that refusal as such; only an unreadable/failed state read is
      // converted into a withdrawn attempt.
      if (error instanceof StructuredQuestionRefused) throw error;
      const failure = new StructuredQuestionDriveFailure(
        error instanceof Error ? error.message : String(error),
        'none',
        { phase: 'state-read' },
      );
      throw new StructuredQuestionAttemptFailed(failure.message, 'withdrawn', failure);
    }
    if (pending === undefined)
      throw new StructuredQuestionRefused(`session ${input.id} has no pending structured question`);
    if (pending.toolUseId !== input.toolUseId)
      throw new StructuredQuestionRefused(
        `the displayed question changed before this answer arrived (expected ${input.toolUseId}, current ${pending.toolUseId})`,
      );
    const answers = validate(
      pending,
      input.answers === undefined ? legacyAnswers(pending, input.labels, input.other, input.responses) : input.answers,
    );
    let confirmation: Awaited<ReturnType<StructuredQuestionDriver['drive']>>;
    try {
      confirmation = await this.driver.drive(input.id, pending, answers);
    } catch (error) {
      const failure =
        error instanceof StructuredQuestionDriveFailure
          ? error
          : new StructuredQuestionDriveFailure(error instanceof Error ? error.message : String(error), 'ambiguous', {
              phase: 'drive',
            });
      const snapshot = await this.recovery.snapshot(input.id).then(
        pane => ({ pane }),
        snapshotError => ({ error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }),
      );
      // Validation and caller typos were refused before the driver. A real driver preflight failure
      // means the durable question and native pane have drifted (dead/scrolled/re-rendered), so even
      // proven non-acceptance gets one bounded, positively-bound Escape and a durable release rather
      // than leaving the session wedged or inviting an unbounded retry loop.
      // Exactly one bounded cancellation attempt. Its adapter sends at most one Escape and refuses
      // before doing so unless this exact form is still positively bound.
      const cancellation = await this.recovery.cancel(input.id, pending).then(
        result => ({ result }),
        cancellationError => ({
          error: cancellationError instanceof Error ? cancellationError.message : String(cancellationError),
        }),
      );
      const context: StructuredQuestionFailureContext = {
        failure,
        ...('pane' in snapshot ? { snapshot: snapshot.pane } : { snapshotError: snapshot.error }),
        ...('result' in cancellation
          ? { cancellation: cancellation.result }
          : { cancellationError: cancellation.error }),
      };
      const questionText = pending.questions.map(question => question.question).join('\n\n');
      if (context.cancellation === undefined) {
        // Escape is an input too. If its effect was not positively observed, the native form may
        // still own the pane even when the original answer drive proved that no answer key landed.
        // Keep both the accepted receipt and the exact durable question: retrying the answer could
        // type into a composer, while fallback prose could answer a still-live selector.
        await this.repository.retained(input.id, pending, answers, context);
        throw new StructuredQuestionAttemptFailed(
          `${failure.message}\n\nAutomatic native cancellation was not confirmed${context.cancellationError === undefined ? '' : `: ${context.cancellationError}`}. The structured form remains bound; inspect the terminal before continuing.\nPending question:\n${questionText}`,
          'accepted',
          failure,
        );
      }
      let releaseError: unknown;
      try {
        await this.repository.failed(input.id, pending, answers, context);
      } catch (error) {
        releaseError = error;
      }
      if (releaseError !== undefined)
        throw new StructuredQuestionAttemptFailed(
          `${failure.message}; failed to release the structured form: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          // The accepted row remains deliberately unsettled. A retry or monitor tick must hard-
          // quarantine it because neither the answer nor the state release reached a commit point.
          'accepted',
          failure,
        );
      throw new StructuredQuestionAttemptFailed(
        `${failure.message}\n\nThe structured form was released.\nReply in prose to:\n${questionText}`,
        failure.acceptance === 'none' ? 'failed' : 'quarantined',
        failure,
      );
    }

    try {
      await this.repository.answered(input.id, pending.toolUseId, answers, confirmation);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const snapshot = await this.recovery.snapshot(input.id).then(
        pane => ({ pane }),
        snapshotError => ({ error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError) }),
      );
      const failure = new StructuredQuestionDriveFailure(
        `the rendered form visibly advanced, but its durable answer state could not be confirmed: ${message}`,
        'ambiguous',
        {
          phase: 'state-confirm',
          confirmedBy: confirmation.confirmedBy,
          ...('error' in snapshot ? { snapshotError: snapshot.error } : {}),
        },
      );
      const context: StructuredQuestionFailureContext = {
        failure,
        releaseConfirmedBy: confirmation.confirmedBy,
        ...('pane' in snapshot ? { snapshot: snapshot.pane } : { snapshotError: snapshot.error }),
      };
      try {
        await this.repository.failed(input.id, pending, answers, context);
      } catch (releaseError) {
        throw new StructuredQuestionAttemptFailed(
          `${failure.message}; failed to release the structured form: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
          'accepted',
          failure,
        );
      }
      throw new StructuredQuestionAttemptFailed(
        `${failure.message}. It was not driven or cancelled again. The visibly advanced form was released; prose may continue, but the original structured answer remains unconfirmed.`,
        'quarantined',
        failure,
      );
    }
  }
}
