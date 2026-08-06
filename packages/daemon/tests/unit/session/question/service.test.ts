import { describe, it } from 'bun:test';
import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import should from 'should';
import {
  StructuredQuestionAttemptFailed,
  type StructuredQuestionCancellation,
  type StructuredQuestionDiagnosticPane,
  StructuredQuestionDriveFailure,
  type StructuredQuestionDriver,
  type StructuredQuestionFailureContext,
  type StructuredQuestionFailureRecovery,
  StructuredQuestionRefused,
  type StructuredQuestionRepository,
  StructuredQuestionService,
} from '../../../../src/lib/session/question/service.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const pending: PendingQuestion = {
  toolUseId: 'question-1',
  questions: [
    { question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] },
    { question: 'Targets?', options: [{ label: 'Web' }, { label: 'API' }], multiSelect: true },
  ],
};

const diagnosticPane: StructuredQuestionDiagnosticPane = {
  alive: true,
  dead: false,
  promptReady: true,
  visible: '> ',
  history: 'Deploy?\n> Yes\n  No',
};

class Answers implements StructuredQuestionRepository {
  readonly delivered: Array<
    readonly [string, string, readonly StructuredQuestionAnswer[], { readonly confirmedBy: string }]
  > = [];
  readonly failures: Array<
    readonly [string, PendingQuestion, readonly StructuredQuestionAnswer[], StructuredQuestionFailureContext]
  > = [];
  readonly retentions: Array<
    readonly [string, PendingQuestion, readonly StructuredQuestionAnswer[], StructuredQuestionFailureContext]
  > = [];
  pendingError: unknown;
  answeredError: unknown;
  failureError: unknown;

  constructor(private readonly question: PendingQuestion | undefined = pending) {}

  async pending(): Promise<PendingQuestion | undefined> {
    if (this.pendingError !== undefined) throw this.pendingError;
    return this.question;
  }

  async answered(
    id: string,
    toolUseId: string,
    answers: readonly StructuredQuestionAnswer[],
    confirmation: { readonly confirmedBy: string },
  ): Promise<void> {
    if (this.answeredError !== undefined) throw this.answeredError;
    this.delivered.push([id, toolUseId, answers, confirmation]);
  }

  async failed(
    id: string,
    question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    context: StructuredQuestionFailureContext,
  ): Promise<void> {
    this.failures.push([id, question, answers, context]);
    if (this.failureError !== undefined) throw this.failureError;
  }

  async retained(
    id: string,
    question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
    context: StructuredQuestionFailureContext,
  ): Promise<void> {
    this.retentions.push([id, question, answers, context]);
  }
}

class Driver implements StructuredQuestionDriver {
  readonly calls: Array<readonly StructuredQuestionAnswer[]> = [];

  constructor(
    private readonly result: Promise<{ readonly confirmedBy: 'prompt-ready' }> = Promise.resolve({
      confirmedBy: 'prompt-ready',
    }),
  ) {}

  async drive(
    _id: typeof ID,
    _question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: 'prompt-ready' }> {
    this.calls.push(answers);
    return this.result;
  }
}

class Recovery implements StructuredQuestionFailureRecovery {
  readonly snapshots: string[] = [];
  readonly cancellations: Array<readonly [string, PendingQuestion]> = [];
  snapshotError: unknown;
  cancellationError: unknown;

  async snapshot(id: string): Promise<StructuredQuestionDiagnosticPane> {
    this.snapshots.push(id);
    if (this.snapshotError !== undefined) throw this.snapshotError;
    return diagnosticPane;
  }

  async cancel(id: string, question: PendingQuestion): Promise<StructuredQuestionCancellation> {
    this.cancellations.push([id, question]);
    if (this.cancellationError !== undefined) throw this.cancellationError;
    return { confirmedBy: 'prompt-ready', pane: diagnosticPane };
  }
}

function subject(question: PendingQuestion | undefined = pending, driver = new Driver()) {
  const repository = new Answers(question);
  const recovery = new Recovery();
  return { repository, driver, recovery, service: new StructuredQuestionService(repository, driver, recovery) };
}

describe('structured question service', () => {
  it('validates all answers, visibly drives them, then clears the exact durable question', async () => {
    const { service, repository, driver, recovery } = subject();

    await service.answer({
      id: ID,
      toolUseId: 'question-1',
      labels: [],
      answers: [
        { kind: 'selection', labels: ['Yes'] },
        { kind: 'selection', labels: ['Web', 'API'] },
      ],
    });

    should(driver.calls).deepEqual([
      [
        { kind: 'selection', labels: ['Yes'] },
        { kind: 'selection', labels: ['Web', 'API'] },
      ],
    ]);
    should(repository.delivered).deepEqual([
      [
        'session-1',
        'question-1',
        [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web', 'API'] },
        ],
        { confirmedBy: 'prompt-ready' },
      ],
    ]);
    should(recovery.snapshots).deepEqual([]);
    should(recovery.cancellations).deepEqual([]);
  });

  it('quarantines an ambiguous drive, snapshots it, cancels once, and releases the durable question', async () => {
    const confirmationFailure = Promise.reject(
      new Error('the answer keys were sent, but the rendered form did not visibly advance'),
    );
    const { service, repository, recovery } = subject(pending, new Driver(confirmationFailure));

    const failure = await service
      .answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      })
      .catch((error: unknown) => error);
    should(repository.delivered).deepEqual([]);
    should(repository.failures).have.length(1);
    should(repository.failures[0]?.[3].failure.acceptance).equal('ambiguous');
    should(recovery.snapshots).deepEqual([ID]);
    should(recovery.cancellations).deepEqual([[ID, pending]]);
    should(failure).be.instanceOf(StructuredQuestionAttemptFailed);
    should(failure).match({ receipt: 'quarantined' });
  });

  it('records a proven pre-key failure as terminal and still performs one bounded cancellation attempt', async () => {
    const driveFailure = Promise.reject(
      new StructuredQuestionDriveFailure('the pane was dead before input', 'none', { phase: 'preflight' }),
    );
    const { service, repository, recovery } = subject(pending, new Driver(driveFailure));

    const failure = await service
      .answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      })
      .catch((error: unknown) => error);

    should(failure).match({ receipt: 'failed' });
    should(repository.failures[0]?.[3]).match({ failure: { acceptance: 'none' } });
    should(recovery.snapshots).deepEqual([ID]);
    should(recovery.cancellations).have.length(1);
  });

  it('keeps the exact question bound when snapshot and cancellation both fail', async () => {
    const { service, repository, recovery } = subject(
      pending,
      new Driver(Promise.reject(new StructuredQuestionDriveFailure('input may have landed', 'ambiguous'))),
    );
    recovery.snapshotError = new Error('capture failed');
    recovery.cancellationError = new Error('Escape could not be confirmed');

    const failure = await service
      .answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      })
      .catch((error: unknown) => error);

    should(failure).match({ receipt: 'accepted' });
    should(repository.failures).deepEqual([]);
    should(repository.retentions[0]?.[3]).match({
      snapshotError: 'capture failed',
      cancellationError: 'Escape could not be confirmed',
    });
    should(recovery.cancellations).have.length(1);
    should((failure as Error).message).match(/Automatic native cancellation was not confirmed/u);
    should((failure as Error).message).match(/structured form remains bound/u);
    should((failure as Error).message).match(/Pending question:\nDeploy\?/u);
  });

  it('leaves the accepted receipt unresolved when the durable release itself fails', async () => {
    const { service, repository } = subject(pending, new Driver(Promise.reject(new Error('drive failed'))));
    repository.failureError = new Error('state document is unreadable');

    const failure = await service
      .answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      })
      .catch((error: unknown) => error);

    should(failure).match({ receipt: 'accepted' });
    should((failure as Error).message).match(/failed to release/u);
  });

  it('treats a pending-state read failure as pre-admission and never touches recovery', async () => {
    const harness = subject();
    harness.repository.pendingError = new Error('state read failed');

    const failure = await harness.service
      .answer({ id: ID, toolUseId: 'question-1', labels: [] })
      .catch((error: unknown) => error);

    should(failure).match({ receipt: 'withdrawn', failure: { acceptance: 'none' } });
    should(harness.driver.calls).deepEqual([]);
    should(harness.recovery.snapshots).deepEqual([]);
    should(harness.repository.failures).deepEqual([]);
  });

  it('releases an atomic-confirmation failure after the pane visibly advanced, without Escape', async () => {
    const harness = subject();
    harness.repository.answeredError = new Error('state write failed');

    const failure = await harness.service
      .answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      })
      .catch((error: unknown) => error);

    should(failure).match({
      receipt: 'quarantined',
      failure: { diagnostics: { phase: 'state-confirm', confirmedBy: 'prompt-ready' } },
    });
    should((failure as Error).message).match(/visibly advanced form was released/u);
    should(harness.repository.failures[0]?.[3]).match({ releaseConfirmedBy: 'prompt-ready' });
    should(harness.recovery.snapshots).deepEqual([ID]);
    should(harness.recovery.cancellations).deepEqual([]);
  });

  it('keeps an atomic-confirmation failure accepted when its durable release also fails', async () => {
    const harness = subject();
    harness.repository.answeredError = new Error('answer state write failed');
    harness.repository.failureError = new Error('release state write failed');

    const failure = await harness.service
      .answer({
        id: ID,
        toolUseId: 'question-1',
        labels: [],
        answers: [
          { kind: 'selection', labels: ['Yes'] },
          { kind: 'selection', labels: ['Web'] },
        ],
      })
      .catch((error: unknown) => error);

    should(failure).match({ receipt: 'accepted' });
    should((failure as Error).message).match(/failed to release/u);
    should(harness.recovery.cancellations).deepEqual([]);
  });

  it('supports the legacy one-question and multi-question payloads without weakening validation', async () => {
    const single: PendingQuestion = {
      toolUseId: 'single',
      questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
    };
    const legacy = subject(single);
    await legacy.service.answer({ id: ID, toolUseId: 'single', labels: ['No'] });
    should(legacy.repository.delivered[0]?.[2]).deepEqual([{ kind: 'selection', labels: ['No'] }]);

    const freeform = subject(single);
    await freeform.service.answer({ id: ID, toolUseId: 'single', labels: [], other: ' because it is ready ' });
    should(freeform.repository.delivered[0]?.[2]).deepEqual([{ kind: 'other', text: 'because it is ready' }]);

    const responses = subject();
    await responses.service.answer({
      id: ID,
      toolUseId: 'question-1',
      labels: [],
      responses: ['Yes', 'a custom target'],
    });
    should(responses.repository.delivered[0]?.[2]).deepEqual([
      { kind: 'selection', labels: ['Yes'] },
      { kind: 'other', text: 'a custom target' },
    ]);
  });

  it('refuses stale, missing, malformed, and ambiguous answers before sending any keys', async () => {
    const missing = subject(undefined);
    await should(missing.service.answer({ id: ID, toolUseId: 'question-1', labels: [] })).be.rejectedWith(
      StructuredQuestionRefused,
    );

    const stale = subject();
    await should(stale.service.answer({ id: ID, toolUseId: 'old-question', labels: [] })).be.rejectedWith(
      /changed before/u,
    );

    for (const answers of [
      [{ kind: 'selection' as const, labels: ['Yes'] }],
      [
        { kind: 'selection' as const, labels: ['Yes', 'No'] },
        { kind: 'selection' as const, labels: ['Web'] },
      ],
      [
        { kind: 'selection' as const, labels: ['Maybe'] },
        { kind: 'selection' as const, labels: ['Web'] },
      ],
      [
        { kind: 'selection' as const, labels: ['Yes'] },
        { kind: 'selection' as const, labels: ['Web', 'Web'] },
      ],
      [
        { kind: 'other' as const, text: ' ' },
        { kind: 'selection' as const, labels: ['Web'] },
      ],
    ]) {
      const invalid = subject();
      await should(invalid.service.answer({ id: ID, toolUseId: 'question-1', labels: [], answers })).be.rejectedWith(
        StructuredQuestionRefused,
      );
      should(invalid.driver.calls).deepEqual([]);
      should(invalid.repository.delivered).deepEqual([]);
    }

    const legacy = subject();
    await should(legacy.service.answer({ id: ID, toolUseId: 'question-1', labels: ['Yes'] })).be.rejectedWith(
      /requires one answer/u,
    );
    await should(
      legacy.service.answer({ id: ID, toolUseId: 'question-1', labels: [], responses: ['Yes'] }),
    ).be.rejectedWith(/expected 2 answers/u);
  });
});
