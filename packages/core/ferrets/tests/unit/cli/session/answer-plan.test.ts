import type { PendingQuestion } from '@ferretry/protocol';
import { describe, it } from 'bun:test';
import should from 'should';
import { planAnswer } from '../../../src/lib/session/answer-plan.ts';
import { SessionCommandError } from '../../../src/lib/session/errors.ts';

const oneQuestion: PendingQuestion = {
  toolUseId: 'tool-1',
  questions: [{ question: 'Ship it?', options: [{ label: 'yes' }, { label: 'no' }] }],
};
const twoQuestions: PendingQuestion = {
  toolUseId: 'tool-2',
  questions: [{ question: 'Ship it?' }, { question: 'Tag it?' }],
};

describe('planAnswer', () => {
  it('should answer with labels against the pending tool call', () => {
    // Arrange / Act
    const plan = planAnswer({ labels: ['yes'] }, oneQuestion);

    // Assert
    should(plan).deepEqual({ toolUseId: 'tool-1', labels: ['yes'] });
  });

  it('should drop blank labels rather than sending empty choices', () => {
    // Arrange / Act
    const plan = planAnswer({ labels: ['  ', 'no'] }, oneQuestion);

    // Assert
    should(plan.labels).deepEqual(['no']);
  });

  it('should carry a free-form Other response', () => {
    // Arrange / Act
    const plan = planAnswer({ other: 'not yet' }, oneQuestion);

    // Assert
    should(plan).deepEqual({ toolUseId: 'tool-1', labels: [], other: 'not yet' });
  });

  it('should carry one response per question in order', () => {
    // Arrange / Act
    const plan = planAnswer({ responses: ['yes', 'no'] }, twoQuestions);

    // Assert
    should(plan).deepEqual({ toolUseId: 'tool-2', labels: [], responses: ['yes', 'no'] });
  });

  it('should refuse an answer that chose nothing at all', () => {
    // Arrange / Act / Assert
    should(() => planAnswer({}, oneQuestion)).throw(/provide labels, --other <text>, or one --response/);
  });

  it('should refuse to answer a session with no question pending', () => {
    // Arrange / Act
    const error = (() => {
      try {
        planAnswer({ labels: ['yes'] }, null);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    // Assert
    should(error).be.instanceof(SessionCommandError);
    should((error as SessionCommandError).message).match(/no pending question/);
    // The session exists and the caller typed a valid command — that is a failed operation, not a
    // usage error, so scripts can tell the two apart.
    should((error as SessionCommandError).exitCode).equal(1);
  });

  it('should treat an absent pendingQuestion the same as an explicit null', () => {
    // Arrange / Act / Assert
    should(() => planAnswer({ labels: ['yes'] }, undefined)).throw(/no pending question/);
  });

  it('should refuse a response count the pending question cannot use', () => {
    // Arrange / Act / Assert
    should(() => planAnswer({ responses: ['yes'] }, twoQuestions)).throw(
      /asked 2 question\(s\); pass exactly one --response for each/,
    );
  });
});
