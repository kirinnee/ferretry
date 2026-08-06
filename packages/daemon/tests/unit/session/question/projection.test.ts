import { describe, it } from 'bun:test';
import should from 'should';
import type { AnswerOperationRecord } from '../../../../src/lib/session/question/answer-ledger.ts';
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

const answer = (outcome: AnswerOperationRecord['outcome'], patch: Partial<AnswerOperationRecord> = {}) => ({
  requestId: 'request-1',
  toolUseId: 'tool-1',
  fingerprint: 'fingerprint-1',
  acceptedAt: '2026-08-06T00:00:00.000Z',
  outcome,
  ...patch,
});

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

  it('repairs a confirmed receipt into state and clears the exact projected form', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
      },
      projectStructuredQuestion([question]),
      [answer('confirmed')],
    );

    should(patch).match({
      status: 'running',
      pendingQuestion: undefined,
      lastAnsweredQuestionToolUseId: 'tool-1',
    });
  });

  it('treats an accepted receipt as confirmed only when the authoritative state stamp proves it', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        lastAnsweredQuestionToolUseId: 'tool-1',
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
      },
      projectStructuredQuestion([question]),
      [answer('accepted')],
    );

    should(patch).match({ status: 'running', pendingQuestion: undefined });
    should(patch).not.have.property('needsHumanKind');
  });

  it('hard-quarantines unresolved accepted evidence and never leaves its form answerable', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
      },
      projectStructuredQuestion([question]),
      [answer('accepted', { reason: 'daemon restarted during the drive' })],
    );

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: 'structured-answer-unconfirmed',
      reason: 'daemon restarted during the drive',
    });
  });

  it('keeps a proven failed operation out of question mode and clears its own stale attention', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
        needsHumanKind: 'structured-answer-unconfirmed',
        needsHuman: 'inspect tool-1 before continuing',
      },
      projectStructuredQuestion([question]),
      [answer('failed', { reason: 'reply in prose' })],
    );

    should(patch).match({ status: 'awaiting_user', pendingQuestion: undefined, reason: 'reply in prose' });
    should(patch).have.property('needsHumanKind', undefined);
    should(patch).have.property('needsHuman', undefined);
  });

  it('raises durable attention when monitor evidence quarantined a form that already advanced', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 1 },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('quarantined', { reason: 'the form advanced without a state stamp' })],
    );

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: 'structured-answer-unconfirmed',
      needsHuman: /tool-1/u,
    });
  });

  it('does not raise attention for a proved non-answer after its form already advanced', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 1 },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('failed', { reason: 'no answer input landed' })],
    );

    should(patch).deepEqual({});
  });

  it('does not churn an exact quarantine attention that is already standing', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_user',
        turn: 1,
        needsHumanKind: 'structured-answer-unconfirmed',
        needsHuman: 'inspect tool-1 before continuing',
      },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('quarantined')],
    );

    should(patch).deepEqual({});
  });

  it('keeps a quarantined operation out of question mode without erasing its unresolved attention', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
        needsHumanKind: 'structured-answer-unconfirmed',
        needsHuman: 'inspect tool-1 before continuing',
      },
      projectStructuredQuestion([question]),
      [answer('quarantined', { reason: 'inspect the terminal' })],
    );

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: 'structured-answer-unconfirmed',
      needsHuman: /tool-1/u,
      reason: 'inspect the terminal',
    });
  });

  it('lets a withdrawn pre-key refusal project the still-open question normally', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 1 },
      projectStructuredQuestion([question]),
      [answer('withdrawn')],
    );

    should(patch).match({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-1' } });
  });

  it('preserves a newer question while settling stale attention for an older accepted operation', () => {
    const newer = {
      ...question,
      call: {
        ...question.call,
        id: 'tool-2',
        questions: [{ question: 'Deploy?', options: [{ label: 'Now' }], multiple: false }],
      },
    } satisfies TranscriptEvent;
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_user',
        turn: 1,
        needsHumanKind: 'structured-answer-unconfirmed',
        needsHuman: 'inspect tool-1 before continuing',
      },
      projectStructuredQuestion([newer]),
      [answer('accepted')],
    );

    should(patch).match({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-2' } });
    should(patch).have.property('needsHumanKind', undefined);
    should(patch).have.property('needsHuman', undefined);
  });

  it('preserves both a newer question and the unresolved attention for an older quarantine', () => {
    const newer = {
      ...question,
      call: {
        ...question.call,
        id: 'tool-2',
        questions: [{ question: 'Deploy?', options: [{ label: 'Now' }], multiple: false }],
      },
    } satisfies TranscriptEvent;
    const current = {
      id: 's1',
      status: 'awaiting_user' as const,
      turn: 1,
      needsHumanKind: 'structured-answer-unconfirmed' as const,
      needsHuman: 'inspect tool-1 before continuing',
    };
    const patch = structuredQuestionStatePatch(current, projectStructuredQuestion([newer]), [answer('quarantined')]);

    should(patch).match({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-2' } });
    should(patch).not.have.property('needsHumanKind');
    should(patch).not.have.property('needsHuman');
    should({ ...current, ...patch }).match({
      needsHumanKind: 'structured-answer-unconfirmed',
      needsHuman: /tool-1/u,
    });
  });

  it('restores missing attention for an older quarantine while exposing a newer question', () => {
    const newer = {
      ...question,
      call: {
        ...question.call,
        id: 'tool-2',
        questions: [{ question: 'Deploy?', options: [{ label: 'Now' }], multiple: false }],
      },
    } satisfies TranscriptEvent;
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 1 },
      projectStructuredQuestion([newer]),
      [answer('quarantined', { reason: 'the earlier form advanced without a state stamp' })],
    );

    should(patch).match({
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: 'tool-2' },
      needsHumanKind: 'structured-answer-unconfirmed',
      needsHuman: /tool-1/u,
      reason: 'the earlier form advanced without a state stamp',
    });
  });

  it('clears only when transcript evidence resolves the exact pending form', () => {
    const result: TranscriptEvent = {
      kind: 'tool-result',
      harness: 'claude',
      role: 'tool',
      result: { callId: 'tool-1', content: null, isError: false },
    };
    const terminal: TranscriptEvent = { kind: 'turn', harness: 'claude', role: 'assistant', state: 'completed' };
    should(projectStructuredQuestion([question, result])).deepEqual({ kind: 'resolved', toolUseId: 'tool-1' });
    should(projectStructuredQuestion([question, terminal])).deepEqual({ kind: 'resolved', toolUseId: 'tool-1' });
    should(
      projectStructuredQuestion([question, { ...result, result: { ...result.result, callId: 'another-tool' } }]),
    ).match({
      kind: 'pending',
    });
  });

  it('never clears another tool’s answer quarantine', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
        needsHumanKind: 'structured-answer-unconfirmed',
        needsHuman: 'inspect tool-2 before continuing',
      },
      projectStructuredQuestion([question]),
      [answer('failed', { reason: 'reply in prose' })],
    );

    should(patch).not.have.property('needsHumanKind');
    should(patch).not.have.property('needsHuman');
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
