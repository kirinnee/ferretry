import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnswerOperationRecord,
  STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
} from '../../../../src/lib/session/question/answer-ledger.ts';
import {
  projectStructuredQuestion,
  structuredQuestionStatePatch,
} from '../../../../src/lib/session/question/projection.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

const ask = (id: string, options: readonly { label: string }[] = [{ label: 'Yes' }]): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: {
    id,
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options, multiple: false }],
  },
});

const record = (outcome: AnswerOperationRecord['outcome'], toolUseId = 'tool-1'): AnswerOperationRecord => ({
  requestId: 'request-1',
  toolUseId,
  fingerprint: 'fingerprint-1',
  acceptedAt: '2026-08-06T00:00:00.000Z',
  outcome,
});

const unconfirmedAttention = (toolUseId: string) => ({
  needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
  needsHuman: `answer request request-1 for ${toolUseId} may have reached the form, and release was not confirmed; inspect the session before continuing`,
});

const none = projectStructuredQuestion([]);

describe('structured question projection branches', () => {
  it('should project a question with no options without an options key', () => {
    // Act
    const projected = projectStructuredQuestion([ask('tool-1', [])]);

    // Assert
    should(projected.kind).equal('pending');
    if (projected.kind === 'pending') should(projected.question.questions[0]).not.have.property('options');
  });

  it('should hand the session to a newer question once the answered one is confirmed', () => {
    // Arrange
    const current = {
      id: 's1',
      status: 'awaiting_question' as const,
      turn: 1,
      pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
    };

    // Act
    const patch = structuredQuestionStatePatch(current, projectStructuredQuestion([ask('tool-2')]), [
      record('confirmed'),
    ]);

    // Assert
    should(patch).match({
      status: 'awaiting_question',
      lastAnsweredQuestionToolUseId: 'tool-1',
      pendingQuestion: { toolUseId: 'tool-2' },
    });
  });

  it('should leave an unconfirmed answer with no bound form waiting on the user', () => {
    // Arrange — the transcript shows the form resolved and nothing is bound in state.
    const resolved = projectStructuredQuestion([
      ask('tool-1'),
      {
        kind: 'tool-result',
        harness: 'claude',
        role: 'user',
        result: { callId: 'tool-1', content: 'ok', isError: false },
      },
    ]);

    // Act
    const patch = structuredQuestionStatePatch({ id: 's1', status: 'running', turn: 1 }, resolved, [
      record('accepted'),
    ]);

    // Assert
    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: /the bound question remains blocked/u,
    });
  });

  it('should change nothing when the unconfirmed answer is already bound and its attention already stands', () => {
    // Arrange
    const current = {
      id: 's1',
      status: 'awaiting_question' as const,
      turn: 1,
      pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
      ...unconfirmedAttention('tool-1'),
    };

    // Act
    const patch = structuredQuestionStatePatch(current, projectStructuredQuestion([ask('tool-1')]), [
      record('accepted'),
    ]);

    // Assert
    should(patch).deepEqual({});
  });

  describe('an acknowledged predecessor whose tool left the transcript', () => {
    const standing = {
      id: 's1',
      turn: 1,
      ...unconfirmedAttention('tool-1'),
    };
    const clearing = { needsHuman: undefined, needsHumanKind: undefined };

    it('should clear the blocking attention and fall back to awaiting the user', () => {
      // Act
      const patch = structuredQuestionStatePatch({ ...standing, status: 'awaiting_question' }, none, [
        record('acknowledged'),
      ]);

      // Assert
      should(patch).match({ status: 'awaiting_user', pendingQuestion: undefined, ...clearing });
    });

    it('should clear the attention without reviving a finished session', () => {
      // Act
      const patch = structuredQuestionStatePatch({ ...standing, status: 'stopped' }, none, [record('acknowledged')]);

      // Assert
      should(patch).match({ status: 'stopped', ...clearing });
    });

    it('should keep a genuinely newer question answerable', () => {
      // Act
      const patch = structuredQuestionStatePatch(
        { ...standing, status: 'awaiting_user' },
        projectStructuredQuestion([ask('tool-2')]),
        [record('acknowledged')],
      );

      // Assert
      should(patch).match({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-2' }, ...clearing });
    });
  });
});
