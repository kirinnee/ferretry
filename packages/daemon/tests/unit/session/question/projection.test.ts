import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AnswerOperationRecord,
  STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
  STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
} from '../../../../src/lib/session/question/answer-ledger.ts';
import {
  firstWriteReleasedAnswerAttention,
  projectStructuredQuestion,
  releasedAnswerAttentionOwnedBy,
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

// The EXACT messages the daemon mints. Ownership fixtures must use them: a hand-written summary
// would pass a substring test while proving nothing about which tool the attention names.
const unconfirmedAttention = (toolUseId = 'tool-1', requestId = 'request-1') => ({
  needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
  needsHuman: `answer request ${requestId} for ${toolUseId} may have reached the form, and release was not confirmed; inspect the session before continuing`,
});

const releasedAttention = (toolUseId = 'tool-1', requestId = 'request-1') => ({
  needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
  needsHuman: `answer request ${requestId} for ${toolUseId} may have reached the form; the form was released, so prose may continue, but the original answer remains unconfirmed`,
});

// The composition root's first write, spelled out here ON PURPOSE rather than built from the
// exported builder: an independent copy is what catches the builder drifting away from the sentence
// the predicate has to recognize.
const compositionRootReleasedAttention = (toolUseId: string) => ({
  needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
  needsHuman: `an answer to ${toolUseId} may have reached the form and was never confirmed; the form was released, so prose may continue, but do not assume the original answer landed`,
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

  it('preserves a non-question status when confirmed evidence repairs the state', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_user',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
      },
      projectStructuredQuestion([question]),
      [answer('confirmed')],
    );

    should(patch).match({
      status: 'awaiting_user',
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

  it('keeps unresolved accepted evidence bound and input-blocking', () => {
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
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: 'tool-1' },
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
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
        ...unconfirmedAttention(),
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
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
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
        ...releasedAttention(),
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
        ...unconfirmedAttention(),
      },
      projectStructuredQuestion([question]),
      [answer('quarantined', { reason: 'inspect the terminal' })],
    );

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
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

  it('preserves a newer question while retaining an older accepted operation as blocking', () => {
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
        ...unconfirmedAttention(),
      },
      projectStructuredQuestion([newer]),
      [answer('accepted')],
    );

    should(patch).match({
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: 'tool-2' },
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: /tool-1/u,
    });
  });

  it('retains the exact bound form when unconfirmed evidence meets a newer projected question', () => {
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
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
      },
      projectStructuredQuestion([newer]),
      [answer('accepted')],
    );

    should(patch).match({
      status: 'awaiting_question',
      pendingQuestion: { toolUseId: 'tool-1' },
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
    });
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
      ...releasedAttention(),
    };
    const patch = structuredQuestionStatePatch(current, projectStructuredQuestion([newer]), [answer('quarantined')]);

    should(patch).match({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-2' } });
    should(patch).not.have.property('needsHumanKind');
    should(patch).not.have.property('needsHuman');
    should({ ...current, ...patch }).match({
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
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
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: /tool-1/u,
      reason: 'the earlier form advanced without a state stamp',
    });
  });

  it('blocks prose for a raw accepted orphan when no question is projected', () => {
    const patch = structuredQuestionStatePatch({ id: 's1', status: 'running', turn: 1 }, { kind: 'none' }, [
      answer('accepted', { reason: 'the daemon restarted before release was confirmed' }),
    ]);

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: /tool-1/u,
      reason: 'the daemon restarted before release was confirmed',
    });
  });

  it('clears the released advisory when the authoritative answer stamp later proves it', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 2,
        lastAnsweredQuestionToolUseId: 'tool-1',
        ...releasedAttention(),
      },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('quarantined')],
    );

    should(patch).have.property('needsHumanKind', undefined);
    should(patch).have.property('needsHuman', undefined);
    should(patch).have.property('lastAnsweredQuestionToolUseId', 'tool-1');
  });

  it('clears a blocking answer attention from a tool-level acknowledgement without confirming it', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 2,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
        ...unconfirmedAttention(),
      },
      projectStructuredQuestion([question]),
      [answer('accepted'), answer('acknowledged', { requestId: 'human-clear' })],
    );

    should(patch).match({ status: 'awaiting_user', pendingQuestion: undefined });
    should(patch).have.property('needsHumanKind', undefined);
    should(patch).have.property('needsHuman', undefined);
    should(patch).not.have.property('lastAnsweredQuestionToolUseId');
  });

  it('leaves an acknowledged tool’s standing released advisory for the resume service to clear', () => {
    const current = {
      id: 's1',
      status: 'awaiting_user' as const,
      turn: 2,
      ...releasedAttention(),
    };
    const records = [answer('quarantined'), answer('acknowledged', { requestId: 'human-clear' })];

    // A READ IS NOT A CLEAR OWNER. The acknowledgement is durable, so the first read after a daemon
    // that crashed between the append and the service's clear sees exactly this state. Retiring the
    // advisory here would turn the session back into an ordinary live one and the bare admin retry
    // that the acknowledgement exists for would be refused.
    for (const projection of [{ kind: 'none' } as const, { kind: 'resolved' as const, toolUseId: 'tool-1' }]) {
      const patch = structuredQuestionStatePatch(current, projection, records);
      should(patch).deepEqual({});
      should({ ...current, ...patch }).match({
        needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
        needsHuman: /tool-1/u,
      });
    }

    // Once the service has cleared it, no read and no restart replay re-mints it.
    const cleared = { ...current, needsHumanKind: undefined, needsHuman: undefined };
    should(structuredQuestionStatePatch(cleared, { kind: 'none' }, records)).deepEqual({});
    should(structuredQuestionStatePatch(cleared, { kind: 'resolved', toolUseId: 'tool-1' }, records)).deepEqual({});
  });

  it('exposes a newer question without retiring an acknowledged tool’s standing advisory', () => {
    const newer = {
      ...question,
      call: {
        ...question.call,
        id: 'tool-2',
        questions: [{ question: 'Deploy?', options: [{ label: 'Now' }], multiple: false }],
      },
    } satisfies TranscriptEvent;
    const current = { id: 's1', status: 'awaiting_user' as const, turn: 2, ...releasedAttention() };
    const patch = structuredQuestionStatePatch(current, projectStructuredQuestion([newer]), [
      answer('quarantined'),
      answer('acknowledged', { requestId: 'human-clear' }),
    ]);

    should(patch).match({ status: 'awaiting_question', pendingQuestion: { toolUseId: 'tool-2' } });
    should(patch).not.have.property('needsHumanKind');
    should(patch).not.have.property('needsHuman');
    should({ ...current, ...patch }).match({
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: /tool-1/u,
    });
  });

  it('retires a standing blocking state from an acknowledgement whose form left the tail', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'awaiting_user', turn: 2, ...unconfirmedAttention() },
      { kind: 'none' },
      [answer('accepted'), answer('acknowledged', { requestId: 'human-clear' })],
    );

    should(patch).match({ status: 'awaiting_user', pendingQuestion: undefined });
    should(patch).have.property('needsHumanKind', undefined);
    should(patch).have.property('needsHuman', undefined);
    should(patch).not.have.property('lastAnsweredQuestionToolUseId');
  });

  it('never lets a confirmed tool-1 clear the released advisory that names tool-10', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 2,
        lastAnsweredQuestionToolUseId: 'tool-1',
        ...releasedAttention('tool-10', 'request-10'),
      },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('confirmed'), answer('quarantined', { requestId: 'request-10', toolUseId: 'tool-10' })],
    );

    should(patch).deepEqual({});
  });

  it('never lets an acknowledged tool-1 retire the blocking advisory that names tool-10', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 2, ...unconfirmedAttention('tool-10', 'request-10') },
      { kind: 'none' },
      [
        answer('acknowledged', { requestId: 'human-clear' }),
        answer('accepted', { requestId: 'request-10', toolUseId: 'tool-10' }),
      ],
    );

    should(patch).deepEqual({});
  });

  it('clears the composition root’s own first-write advisory, and only for the tool it names', () => {
    const cleared = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 2,
        lastAnsweredQuestionToolUseId: 'tool-10',
        ...compositionRootReleasedAttention('tool-10'),
      },
      { kind: 'resolved', toolUseId: 'tool-10' },
      [answer('quarantined', { requestId: 'request-10', toolUseId: 'tool-10' })],
    );
    should(cleared).have.property('needsHumanKind', undefined);
    should(cleared).have.property('needsHuman', undefined);
    should(cleared).have.property('lastAnsweredQuestionToolUseId', 'tool-10');

    const collided = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 2,
        lastAnsweredQuestionToolUseId: 'tool-1',
        ...compositionRootReleasedAttention('tool-10'),
      },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('confirmed'), answer('quarantined', { requestId: 'request-10', toolUseId: 'tool-10' })],
    );
    should(collided).deepEqual({});
  });

  it('owns an advisory whose request id contains spaces, still tool by tool', () => {
    const standing = structuredQuestionStatePatch(
      { id: 's1', status: 'awaiting_user', turn: 2, ...releasedAttention('tool-1', 'req 42') },
      { kind: 'none' },
      [answer('quarantined', { requestId: 'req 42' })],
    );
    should(standing).deepEqual({});

    const collided = structuredQuestionStatePatch(
      { id: 's1', status: 'awaiting_user', turn: 2, ...releasedAttention('tool-10', 'req 42') },
      { kind: 'none' },
      [answer('quarantined', { requestId: 'req 42' })],
    );
    should(collided).match({ needsHuman: /^answer request req 42 for tool-1 may have reached the form/u });
  });

  it('writes the composition root’s first-write advisory exactly, for any id', () => {
    should(firstWriteReleasedAnswerAttention('tool-10')).equal(
      'an answer to tool-10 may have reached the form and was never confirmed; the form was released, so prose may continue, but do not assume the original answer landed',
    );
    should(firstWriteReleasedAnswerAttention('tool 10')).equal(
      'an answer to tool 10 may have reached the form and was never confirmed; the form was released, so prose may continue, but do not assume the original answer landed',
    );

    // The predicate's first-write branch reads that same sentence, so the writer and the reader
    // cannot drift apart: whatever the builder emits is exactly what owns the advisory.
    should(
      releasedAnswerAttentionOwnedBy(
        {
          id: 's1',
          status: 'awaiting_user',
          turn: 2,
          needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
          needsHuman: firstWriteReleasedAnswerAttention('tool 10'),
        },
        answer('quarantined', { requestId: 'req 42', toolUseId: 'tool 10' }),
      ),
    ).be.true();
  });

  it('answers released-advisory ownership per record, for any id an acknowledgment may name', () => {
    const state = (patch: Record<string, unknown>) => ({
      id: 's1',
      status: 'awaiting_user' as const,
      turn: 2,
      ...patch,
    });
    const record = answer('quarantined', { requestId: 'req 42', toolUseId: 'tool 10' });

    should(releasedAnswerAttentionOwnedBy(state(releasedAttention('tool 10', 'req 42')), record)).be.true();
    should(releasedAnswerAttentionOwnedBy(state(compositionRootReleasedAttention('tool 10')), record)).be.true();

    // A different request id, a colliding tool id, a delimiter-bearing id, the blocking kind and an
    // unrecognized message are all NOT owners: an acknowledgment may never clear on any of them.
    should(releasedAnswerAttentionOwnedBy(state(releasedAttention('tool 10', 'req 43')), record)).be.false();
    should(releasedAnswerAttentionOwnedBy(state(releasedAttention('tool 1', 'req 42')), record)).be.false();
    should(releasedAnswerAttentionOwnedBy(state(releasedAttention('10', 'req 42 for tool')), record)).be.false();
    should(releasedAnswerAttentionOwnedBy(state(unconfirmedAttention('tool 10', 'req 42')), record)).be.false();
    should(
      releasedAnswerAttentionOwnedBy(
        state({ needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND, needsHuman: 'inspect tool 10' }),
        record,
      ),
    ).be.false();
    should(releasedAnswerAttentionOwnedBy(state({}), record)).be.false();
  });

  it('owns a released advisory for a tool id containing whitespace, and only that id', () => {
    const standing = { id: 's1', status: 'awaiting_user' as const, turn: 2, ...releasedAttention('tool 10', 'req 42') };
    should(
      structuredQuestionStatePatch(standing, { kind: 'none' }, [
        answer('quarantined', { requestId: 'req 42', toolUseId: 'tool 10' }),
      ]),
    ).deepEqual({});

    should(
      structuredQuestionStatePatch(standing, { kind: 'none' }, [
        answer('quarantined', { requestId: 'req 42', toolUseId: 'tool' }),
      ]),
    ).match({ needsHuman: /^answer request req 42 for tool may have reached the form;/u });
  });

  it('owns a blocking advisory for a tool id containing whitespace, and only that id', () => {
    const standing = {
      id: 's1',
      status: 'awaiting_user' as const,
      turn: 2,
      ...unconfirmedAttention('tool 10', 'req 42'),
    };
    should(
      structuredQuestionStatePatch(standing, { kind: 'none' }, [
        answer('accepted', { requestId: 'req 42', toolUseId: 'tool 10' }),
      ]),
    ).deepEqual({});

    should(
      structuredQuestionStatePatch(standing, { kind: 'none' }, [
        answer('accepted', { requestId: 'req 42', toolUseId: 'tool' }),
      ]),
    ).match({ needsHuman: /^answer request req 42 for tool may have reached the form, and release/u });
  });

  // A rendered sentence is not an injective encoding of the pair that built it: (requestId 'r',
  // toolUseId 't for u') and (requestId 'r for t', toolUseId 'u') render the SAME message. Two
  // owners must fail closed everywhere, or one tool's evidence settles the other tool's advisory.
  const ambiguousReleased = releasedAttention('t for u', 'r');
  const ambiguousBlocking = unconfirmedAttention('t for u', 'r');

  it('renders one message for two distinct records, and never clears a released advisory on it', () => {
    should(ambiguousReleased.needsHuman).equal(releasedAttention('u', 'r for t').needsHuman);
    should(ambiguousBlocking.needsHuman).equal(unconfirmedAttention('u', 'r for t').needsHuman);

    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 2,
        lastAnsweredQuestionToolUseId: 't for u',
        ...ambiguousReleased,
      },
      { kind: 'resolved', toolUseId: 't for u' },
      [
        answer('confirmed', { requestId: 'r', toolUseId: 't for u' }),
        answer('quarantined', { requestId: 'r for t', toolUseId: 'u' }),
      ],
    );

    should(patch).deepEqual({});
  });

  it('re-asserts rather than trusting an ambiguous released advisory two records own', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'awaiting_user', turn: 2, ...ambiguousReleased },
      { kind: 'none' },
      [
        answer('quarantined', { requestId: 'r', toolUseId: 't for u' }),
        answer('quarantined', { requestId: 'r for t', toolUseId: 'u' }),
      ],
    );

    should(patch).have.property('needsHumanKind', STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND);
    should(patch).have.property('needsHuman', ambiguousReleased.needsHuman);
  });

  it('never acknowledges away a blocking advisory two records own', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 2, ...ambiguousBlocking },
      { kind: 'none' },
      [
        answer('acknowledged', { requestId: 'r for t', toolUseId: 'u' }),
        answer('accepted', { requestId: 'r', toolUseId: 't for u' }),
      ],
    );

    should(patch).have.property('needsHumanKind', STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND);
    should(patch).have.property('needsHuman', ambiguousBlocking.needsHuman);
  });

  it('re-asserts rather than trusting an ambiguous blocking advisory two records own', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'awaiting_user', turn: 2, ...ambiguousBlocking },
      { kind: 'none' },
      [
        answer('accepted', { requestId: 'r', toolUseId: 't for u' }),
        answer('accepted', { requestId: 'r for t', toolUseId: 'u' }),
      ],
    );

    should(patch).have.property('needsHumanKind', STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND);
    should(patch).have.property('needsHuman', ambiguousBlocking.needsHuman);
  });

  it('never lets a tool id spelled into another advisory own the released one', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'running',
        turn: 2,
        lastAnsweredQuestionToolUseId: 'tool-1',
        ...releasedAttention('1 for tool-1', 'request-9'),
      },
      { kind: 'resolved', toolUseId: 'tool-1' },
      [answer('confirmed'), answer('quarantined', { requestId: 'request-9', toolUseId: '1 for tool-1' })],
    );

    should(patch).deepEqual({});
  });

  it('never lets a tool id spelled into another advisory own the blocking one', () => {
    const patch = structuredQuestionStatePatch(
      { id: 's1', status: 'running', turn: 2, ...unconfirmedAttention('1 for tool-1', 'request-9') },
      { kind: 'none' },
      [
        answer('acknowledged', { requestId: 'human-clear' }),
        answer('accepted', { requestId: 'request-9', toolUseId: '1 for tool-1' }),
      ],
    );

    should(patch).deepEqual({});
  });

  it('fails closed on an attention message it cannot read, then re-mints the canonical one', () => {
    const current = {
      id: 's1',
      status: 'awaiting_user' as const,
      turn: 2,
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: 'inspect tool-1 before continuing',
    };
    const records = [answer('quarantined')];

    const remint = structuredQuestionStatePatch(current, { kind: 'none' }, records);
    should(remint).match({
      status: 'awaiting_user',
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: /^answer request request-1 for tool-1 may have reached the form/u,
    });

    should(structuredQuestionStatePatch({ ...current, ...remint }, { kind: 'none' }, records)).deepEqual({});
  });

  it('re-mints a later accepted operation despite an older tool’s acknowledgement', () => {
    const patch = structuredQuestionStatePatch({ id: 's1', status: 'running', turn: 1 }, { kind: 'none' }, [
      answer('acknowledged', { requestId: 'human-clear' }),
      answer('accepted', { requestId: 'request-2', toolUseId: 'tool-2', fingerprint: 'fingerprint-2' }),
    ]);

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: /request-2 for tool-2/u,
    });
  });

  it('re-mints a later quarantine despite an older tool’s acknowledgement', () => {
    const patch = structuredQuestionStatePatch({ id: 's1', status: 'running', turn: 1 }, { kind: 'none' }, [
      answer('acknowledged', { requestId: 'human-clear' }),
      answer('quarantined', { requestId: 'request-2', toolUseId: 'tool-2', fingerprint: 'fingerprint-2' }),
    ]);

    should(patch).match({
      status: 'awaiting_user',
      pendingQuestion: undefined,
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: /request-2 for tool-2/u,
    });
  });

  it('clears only when transcript evidence resolves the exact pending form', () => {
    const result: TranscriptEvent = {
      kind: 'tool-result',
      harness: 'claude',
      role: 'tool',
      result: { callId: 'tool-1', content: null, isError: false },
    };
    should(projectStructuredQuestion([question, result])).deepEqual({ kind: 'resolved', toolUseId: 'tool-1' });
    should(
      projectStructuredQuestion([question, { ...result, result: { ...result.result, callId: 'another-tool' } }]),
    ).match({
      kind: 'pending',
    });
  });

  it('never releases an open form on a terminal turn alone', () => {
    const completed: TranscriptEvent = { kind: 'turn', harness: 'claude', role: 'assistant', state: 'completed' };
    const aborted: TranscriptEvent = { ...completed, state: 'aborted' } satisfies TranscriptEvent;

    should(projectStructuredQuestion([question, completed])).match({
      kind: 'pending',
      question: { toolUseId: 'tool-1' },
    });
    should(projectStructuredQuestion([question, aborted])).match({
      kind: 'pending',
      question: { toolUseId: 'tool-1' },
    });
    // A terminal turn AFTER a real tool result still resolves: the result, not the turn, released it.
    should(
      projectStructuredQuestion([
        question,
        {
          kind: 'tool-result',
          harness: 'claude',
          role: 'tool',
          result: { callId: 'tool-1', content: null, isError: false },
        },
        aborted,
      ]),
    ).deepEqual({ kind: 'resolved', toolUseId: 'tool-1' });
  });

  it('keeps an unconfirmed answer blocking and never prose-permitting after a terminal turn', () => {
    for (const state of ['completed', 'aborted'] as const) {
      const patch = structuredQuestionStatePatch(
        { id: 's1', status: 'running', turn: 1 },
        projectStructuredQuestion([question, { kind: 'turn', harness: 'claude', role: 'assistant', state }]),
        [answer('accepted', { reason: 'the drive was interrupted before release was confirmed' })],
      );

      should(patch).match({
        status: 'awaiting_question',
        pendingQuestion: { toolUseId: 'tool-1' },
        needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
        reason: 'the drive was interrupted before release was confirmed',
      });
    }
  });

  it('never clears another tool’s answer quarantine', () => {
    const patch = structuredQuestionStatePatch(
      {
        id: 's1',
        status: 'awaiting_question',
        turn: 1,
        pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
        ...unconfirmedAttention('tool-2', 'request-2'),
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

  it('materializes question evidence without ever making a kill-failed pane input-capable', () => {
    const pending = projectStructuredQuestion([question]);
    const current = {
      id: 's1',
      status: 'kill_failed' as const,
      turn: 1,
      pendingQuestion: { toolUseId: 'tool-1', questions: [{ question: 'Ship?' }] },
    };

    for (const outcome of ['accepted', 'confirmed', 'failed', 'quarantined', 'acknowledged', 'withdrawn'] as const)
      should(structuredQuestionStatePatch(current, pending, [answer(outcome)]).status).equal('kill_failed');

    should(
      structuredQuestionStatePatch(
        { id: 's1', status: 'kill_failed', turn: 1 },
        { kind: 'needs-human', reason: 'the question shape is unknown' },
      ),
    ).match({ status: 'kill_failed', needsHumanKind: 'structured-question-unrecognized' });
  });
});
