import { describe, it } from 'bun:test';
import type { PendingQuestion } from '@ferretry/protocol';
import should from 'should';
import {
  StructuredQuestionAttemptFailed,
  type StructuredQuestionDriver,
  type StructuredQuestionFailureContext,
  type StructuredQuestionFailureRecovery,
  StructuredQuestionRefused,
  type StructuredQuestionRepository,
  StructuredQuestionService,
} from '../../../../src/lib/session/question/service.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

const ID = parseSessionId('session-1');
const PENDING: PendingQuestion = {
  toolUseId: 'question-1',
  questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }, { label: 'No' }] }],
};

interface Harness {
  readonly service: StructuredQuestionService;
  readonly released: StructuredQuestionFailureContext[];
  readonly driven: number[];
}

function harness(options: {
  readonly pending: PendingQuestion | undefined;
  readonly answeredError?: Error;
  readonly snapshotError?: unknown;
}): Harness {
  const released: StructuredQuestionFailureContext[] = [];
  const driven: number[] = [];
  const repository: StructuredQuestionRepository = {
    pending: async () => options.pending,
    answered: async () => {
      if (options.answeredError !== undefined) throw options.answeredError;
    },
    failed: async (_id, _question, _answers, context) => {
      released.push(context);
    },
    paused: async () => undefined,
    retained: async () => undefined,
  };
  const driver: StructuredQuestionDriver = {
    drive: async () => {
      driven.push(1);
      return { confirmedBy: 'prompt-ready' };
    },
  };
  const recovery: StructuredQuestionFailureRecovery = {
    snapshot: async () => {
      throw options.snapshotError ?? new Error('no pane');
    },
    cancel: async () => {
      throw new Error('not expected');
    },
  };
  return { service: new StructuredQuestionService(repository, driver, recovery), released, driven };
}

const answer = { id: ID, toolUseId: 'question-1', labels: ['Yes'] } as const;

describe('structured question service, at its edges', () => {
  it('should refuse an answer when the session has no pending structured question, without driving the pane', async () => {
    // Arrange
    const subject = harness({ pending: undefined });

    // Act
    const failure = await subject.service.answer(answer).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(StructuredQuestionRefused);
    should((failure as Error).message).equal('session session-1 has no pending structured question');
    should(subject.driven).deepEqual([]);
  });

  it('should keep the answer quarantined and record why when the pane cannot be snapshotted after the form advanced', async () => {
    // Arrange: the state write fails after the pane visibly advanced, and the diagnostic snapshot fails too.
    const subject = harness({
      pending: PENDING,
      answeredError: new Error('state write failed'),
      snapshotError: new Error('the pane is gone'),
    });

    // Act
    const failure = await subject.service.answer(answer).catch((error: unknown) => error);

    // Assert
    should(failure).be.instanceOf(StructuredQuestionAttemptFailed);
    should(failure).match({ receipt: 'quarantined', failure: { diagnostics: { snapshotError: 'the pane is gone' } } });
    should(subject.released[0]?.snapshotError).equal('the pane is gone');
  });

  it('should name a snapshot failure that was not an Error by its text', async () => {
    // Arrange
    const subject = harness({
      pending: PENDING,
      answeredError: new Error('state write failed'),
      snapshotError: 'timeout',
    });

    // Act
    await subject.service.answer(answer).catch(() => undefined);

    // Assert
    should(subject.released[0]?.snapshotError).equal('timeout');
  });
});
