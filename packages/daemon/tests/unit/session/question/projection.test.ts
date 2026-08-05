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
});
