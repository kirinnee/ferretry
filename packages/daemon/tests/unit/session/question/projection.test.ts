import { describe, it } from 'bun:test';
import should from 'should';
import {
  projectStructuredQuestion,
  structuredQuestionStatePatch,
} from '../../../../src/lib/session/question/projection.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

const question: TranscriptEvent = {
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: {
    id: 'tool-1',
    name: 'AskUserQuestion',
    input: {},
    questions: [{ question: 'Ship?', options: [{ label: 'Yes' }, { label: 'No' }], multiple: false }],
  },
};

describe('structured question projection', () => {
  it('projects a recognized open tool call into the daemon state shape', () => {
    const projected = projectStructuredQuestion([question]);
    should(projected).match({
      kind: 'pending',
      question: { toolUseId: 'tool-1', questions: [{ question: 'Ship?', options: [{ label: 'Yes' }] }] },
    });
  });

  it('treats an unrecognized question tool as human intervention, not no question', () => {
    const projected = projectStructuredQuestion([{ ...question, call: { ...question.call, questions: undefined } }]);
    should(projected).match({ kind: 'needs-human' });
    const patch = structuredQuestionStatePatch({ id: 's1', status: 'running', turn: 1 }, projected);
    should(patch).match({ status: 'awaiting_user', needsHumanKind: 'structured-question-unrecognized' });
  });

  it('does not resurrect the exact form the driver already confirmed', () => {
    const pending = projectStructuredQuestion([question]);
    const state = {
      id: 's1',
      status: 'running' as const,
      turn: 1,
      lastAnsweredQuestionToolUseId: 'tool-1',
    };
    should(structuredQuestionStatePatch(state, pending)).deepEqual({});
  });

  it('clears only when transcript evidence resolves the exact pending form', () => {
    const result: TranscriptEvent = {
      kind: 'tool-result',
      harness: 'claude',
      role: 'tool',
      result: { callId: 'tool-1', content: null, isError: false },
    };
    const terminal: TranscriptEvent = { kind: 'turn', harness: 'claude', role: 'assistant', state: 'completed' };
    should(projectStructuredQuestion([question, result])).deepEqual({ kind: 'none' });
    should(projectStructuredQuestion([question, terminal])).deepEqual({ kind: 'none' });
    should(
      projectStructuredQuestion([question, { ...result, result: { ...result.result, callId: 'another-tool' } }]),
    ).match({
      kind: 'pending',
    });
  });

  it('preserves terminal status, clears quarantine after a recognized form, and removes stale question state', () => {
    const pending = projectStructuredQuestion([question]);
    const terminal = structuredQuestionStatePatch(
      { id: 's1', status: 'completed', turn: 1, needsHumanKind: 'structured-question-unrecognized' },
      pending,
    );
    should(terminal).match({ status: 'completed', needsHumanKind: undefined });

    const none = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
        needsHumanKind: 'structured-question-unrecognized',
      },
      { kind: 'none' },
    );
    should(none).deepEqual({ pendingQuestion: undefined, needsHumanKind: undefined });
    should(structuredQuestionStatePatch({ id: 's1', status: 'running', turn: 1 }, { kind: 'none' })).deepEqual({});
  });
});
