import type { PendingQuestion, SessionState } from '@ferretry/protocol';
import type { TranscriptEvent, TranscriptQuestion } from '../../transcript/types.ts';
import {
  type AnswerOperationRecord,
  STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
  STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
  answerEvidenceForQuestion,
} from './answer-ledger.ts';

export type StructuredQuestionProjection =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly question: PendingQuestion }
  | { readonly kind: 'resolved'; readonly toolUseId: string }
  | { readonly kind: 'needs-human'; readonly reason: string };

const answerAttentionFor = (state: SessionState, kind: string, toolUseId: string | undefined): boolean =>
  toolUseId !== undefined && state.needsHumanKind === kind && state.needsHuman?.includes(toolUseId) === true;

const unresolvedAnswerAttentionFor = (state: SessionState, toolUseId: string | undefined): boolean =>
  answerAttentionFor(state, STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND, toolUseId);

const releasedAnswerAttentionFor = (state: SessionState, toolUseId: string | undefined): boolean =>
  answerAttentionFor(state, STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND, toolUseId);

const ownedAnswerAttentionFor = (state: SessionState, toolUseId: string | undefined): boolean =>
  unresolvedAnswerAttentionFor(state, toolUseId) || releasedAnswerAttentionFor(state, toolUseId);

const clearAnswerAttention = { needsHuman: undefined, needsHumanKind: undefined } as const;

function isQuestionTool(name: string): boolean {
  return /^(askuserquestion|request_user_input)$/iu.test(name);
}

function questionShape(questions: readonly TranscriptQuestion[]): PendingQuestion['questions'] {
  return questions.map(question => ({
    question: question.question,
    ...(question.header === undefined ? {} : { header: question.header }),
    ...(question.options.length === 0
      ? {}
      : {
          options: question.options.map(option => ({
            label: option.label,
            ...(option.description === undefined ? {} : { description: option.description }),
          })),
        }),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

/**
 * Recover the still-open question from transcript evidence.  Unknown question
 * tools deliberately become a human intervention, never an empty state: an
 * empty projection would let ordinary send or interrupt type into a form.
 */
export function projectStructuredQuestion(events: readonly TranscriptEvent[]): StructuredQuestionProjection {
  let pending: PendingQuestion | undefined;
  let resolvedToolUseId: string | undefined;
  for (const event of events) {
    if (event.kind === 'tool-call' && isQuestionTool(event.call.name)) {
      if (event.call.questions === undefined || event.call.questions.length === 0)
        return { kind: 'needs-human', reason: `unrecognized structured-question shape for tool ${event.call.id}` };
      pending = {
        toolUseId: event.call.id,
        questions: questionShape(event.call.questions),
        ...(event.timestamp === undefined ? {} : { askedAt: event.timestamp, lastSeenAt: event.timestamp }),
      };
      continue;
    }
    if (event.kind === 'tool-result' && pending?.toolUseId === event.result.callId) {
      resolvedToolUseId = pending.toolUseId;
      pending = undefined;
    }
    if (event.kind === 'turn' && (event.state === 'completed' || event.state === 'aborted') && pending !== undefined) {
      // A terminal turn does NOT prove an answer landed; it proves only that this modal can no
      // longer be the active form. Reconciliation uses this identity to quarantine an accepted
      // receipt (never confirm it or re-drive it) and to stop projecting stale question state.
      resolvedToolUseId = pending.toolUseId;
      pending = undefined;
    }
  }
  if (pending !== undefined) return { kind: 'pending', question: pending };
  return resolvedToolUseId === undefined ? { kind: 'none' } : { kind: 'resolved', toolUseId: resolvedToolUseId };
}

/** State patch for a projection.  It is intentionally partial: storage keeps timestamps and other monitor evidence. */
export function structuredQuestionStatePatch(
  current: SessionState,
  projection: StructuredQuestionProjection,
  answerRecords: Iterable<AnswerOperationRecord> = [],
): Partial<SessionState> {
  const records = [...answerRecords];
  const projectedToolUseId =
    projection.kind === 'pending'
      ? projection.question.toolUseId
      : projection.kind === 'resolved'
        ? projection.toolUseId
        : undefined;
  const toolUseId = current.pendingQuestion?.toolUseId ?? projectedToolUseId;
  const evidence = toolUseId === undefined ? { kind: 'none' as const } : answerEvidenceForQuestion(records, toolUseId);
  const terminal = current.status === 'completed' || current.status === 'stopped' || current.status === 'failed';
  const newerQuestion =
    projection.kind === 'pending' && projection.question.toolUseId !== toolUseId ? projection.question : undefined;
  if (
    evidence.kind === 'confirmed' ||
    ((evidence.kind === 'unconfirmed' || evidence.kind === 'quarantined') &&
      current.lastAnsweredQuestionToolUseId === toolUseId)
  ) {
    if (
      current.lastAnsweredQuestionToolUseId === toolUseId &&
      current.pendingQuestion === undefined &&
      !ownedAnswerAttentionFor(current, toolUseId)
    )
      return {};
    return {
      pendingQuestion: newerQuestion,
      lastAnsweredQuestionToolUseId: toolUseId,
      status: terminal
        ? current.status
        : newerQuestion === undefined
          ? current.status === 'awaiting_question'
            ? 'running'
            : current.status
          : 'awaiting_question',
      ...(ownedAnswerAttentionFor(current, toolUseId) ? clearAnswerAttention : {}),
    };
  }
  if (evidence.kind === 'quarantined') {
    if (
      newerQuestion === undefined &&
      current.pendingQuestion === undefined &&
      releasedAnswerAttentionFor(current, evidence.record.toolUseId)
    )
      return {};
    return {
      pendingQuestion: newerQuestion,
      status: terminal ? current.status : newerQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: `answer request ${evidence.record.requestId} for ${evidence.record.toolUseId} may have reached the form; the form was released, so prose may continue, but the original answer remains unconfirmed`,
      ...(evidence.record.reason === undefined ? {} : { reason: evidence.record.reason }),
    };
  }
  if (evidence.kind === 'released' || evidence.kind === 'acknowledged') {
    const clearOwnedAttention = ownedAnswerAttentionFor(current, toolUseId);
    if (
      newerQuestion === undefined &&
      current.pendingQuestion === undefined &&
      current.status !== 'awaiting_question' &&
      !clearOwnedAttention
    )
      return {};
    return {
      pendingQuestion: newerQuestion,
      status: terminal ? current.status : newerQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      ...(evidence.kind === 'released' && evidence.record.reason !== undefined
        ? { reason: evidence.record.reason }
        : {}),
      ...(clearOwnedAttention ? clearAnswerAttention : {}),
    };
  }
  if (evidence.kind === 'unconfirmed') {
    // An accepted receipt without an answer stamp is not release evidence. In particular, an
    // Escape whose effect was not observed must leave the exact durable binding in place even if a
    // newer transcript tail is visible; monitor reconciliation promotes the receipt first whenever
    // that newer tail positively proves an advance.
    const boundQuestion =
      current.pendingQuestion?.toolUseId === evidence.record.toolUseId
        ? current.pendingQuestion
        : projection.kind === 'pending' && projection.question.toolUseId === evidence.record.toolUseId
          ? projection.question
          : undefined;
    if (
      current.pendingQuestion?.toolUseId === boundQuestion?.toolUseId &&
      unresolvedAnswerAttentionFor(current, evidence.record.toolUseId)
    )
      return {};
    return {
      pendingQuestion: boundQuestion,
      status: terminal ? current.status : boundQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: `answer request ${evidence.record.requestId} for ${evidence.record.toolUseId} may have reached the form, and release was not confirmed; the bound question remains blocked and was not sent again`,
      ...(evidence.record.reason === undefined ? {} : { reason: evidence.record.reason }),
    };
  }

  // An explicit human relaunch acknowledges the append-only predecessors for this tool. When its
  // transcript identity has already slid out of the tail, clear the answer attention by the ledger
  // fact rather than re-minting it from the older quarantine on the next read.
  const orphanAcknowledgement = records.find(
    record => record.outcome === 'acknowledged' && current.lastAnsweredQuestionToolUseId !== record.toolUseId,
  );
  if (orphanAcknowledgement !== undefined) {
    const pendingQuestion = projection.kind === 'pending' ? projection.question : undefined;
    const clearOwnedAttention = ownedAnswerAttentionFor(current, orphanAcknowledgement.toolUseId);
    if (pendingQuestion === undefined && current.pendingQuestion === undefined && !clearOwnedAttention) return {};
    return {
      pendingQuestion,
      status: terminal
        ? current.status
        : pendingQuestion === undefined
          ? current.status === 'awaiting_question'
            ? 'awaiting_user'
            : current.status
          : 'awaiting_question',
      ...(clearOwnedAttention ? clearAnswerAttention : {}),
    };
  }

  // Monitor reconciliation normally turns an accepted predecessor into a quarantine before this
  // patch runs. If the durable state no longer names that predecessor, still restore its operator
  // attention while allowing a genuinely newer question to remain answerable.
  const orphanQuarantine =
    evidence.kind === 'none'
      ? records.find(
          record => record.outcome === 'quarantined' && current.lastAnsweredQuestionToolUseId !== record.toolUseId,
        )
      : undefined;
  if (orphanQuarantine !== undefined) {
    const pendingQuestion = projection.kind === 'pending' ? projection.question : undefined;
    const attentionStanding = releasedAnswerAttentionFor(current, orphanQuarantine.toolUseId);
    if (pendingQuestion === undefined && current.pendingQuestion === undefined && attentionStanding) return {};
    return {
      pendingQuestion,
      status: terminal ? current.status : pendingQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      ...(attentionStanding
        ? {}
        : {
            needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
            needsHuman: `answer request ${orphanQuarantine.requestId} for ${orphanQuarantine.toolUseId} may have reached the form; the form was released, so prose may continue, but the original answer remains unconfirmed`,
          }),
      ...(orphanQuarantine.reason === undefined ? {} : { reason: orphanQuarantine.reason }),
    };
  }

  // An accepted operation whose old form is no longer the projected/current one is still unresolved.
  // A newer question is not permission to forget that keys may have landed on its predecessor.
  const orphan = records.find(
    record => record.outcome === 'accepted' && current.lastAnsweredQuestionToolUseId !== record.toolUseId,
  );
  if (orphan !== undefined) {
    const pendingQuestion = projection.kind === 'pending' ? projection.question : undefined;
    if (
      current.pendingQuestion?.toolUseId === pendingQuestion?.toolUseId &&
      unresolvedAnswerAttentionFor(current, orphan.toolUseId)
    )
      return {};
    return {
      pendingQuestion,
      status: terminal ? current.status : pendingQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: `answer request ${orphan.requestId} for ${orphan.toolUseId} may have reached the form, and release was not confirmed; inspect the session before continuing`,
      ...(orphan.reason === undefined ? {} : { reason: orphan.reason }),
    };
  }

  if (projection.kind === 'pending' && current.lastAnsweredQuestionToolUseId === projection.question.toolUseId)
    return {};
  if (projection.kind === 'pending') {
    const staleAnswerAttention = records.some(
      record =>
        record.toolUseId !== projection.question.toolUseId &&
        record.outcome !== 'withdrawn' &&
        record.outcome !== 'quarantined' &&
        ownedAnswerAttentionFor(current, record.toolUseId),
    );
    return {
      pendingQuestion: projection.question,
      status:
        current.status === 'completed' || current.status === 'stopped' || current.status === 'failed'
          ? current.status
          : 'awaiting_question',
      ...(current.needsHumanKind === 'structured-question-unrecognized' ? { needsHumanKind: undefined } : {}),
      ...(staleAnswerAttention ? clearAnswerAttention : {}),
    };
  }
  if (projection.kind === 'needs-human')
    return {
      pendingQuestion: undefined,
      status:
        current.status === 'completed' || current.status === 'stopped' || current.status === 'failed'
          ? current.status
          : 'awaiting_user',
      needsHumanKind: 'structured-question-unrecognized',
      reason: projection.reason,
    };
  return current.pendingQuestion === undefined && current.needsHumanKind !== 'structured-question-unrecognized'
    ? {}
    : {
        pendingQuestion: undefined,
        ...(current.needsHumanKind === 'structured-question-unrecognized' ? { needsHumanKind: undefined } : {}),
      };
}
