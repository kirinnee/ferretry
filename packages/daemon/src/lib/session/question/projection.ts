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

// ONE OWNER FOR WHAT AN ANSWER ATTENTION SAYS. These builders are the only place any answer
// attention sentence is written, the first write in the composition root included — it calls the
// exported builder rather than repeating the sentence, because a second copy of the wording is a
// second owner, and ownership below is decided by comparing the standing `needsHuman` against
// exactly these strings. Ownership is never decided by looking for the id inside the
// prose: `needsHuman.includes(toolUseId)` was true for `tool-1` against a message naming `tool-10`,
// so one tool's confirmation or acknowledgement silently erased another tool's standing advisory,
// and reading the id back out of the sentence cannot be exact either — a request id only has to be
// non-empty and a tool id only has to be non-empty, so either may contain spaces or the delimiter
// words themselves. Anything this daemon would not have written fails closed to NOT owned: nothing
// is cleared on its evidence, and the next read re-mints the canonical message from the record the
// ledger still holds.
const unconfirmedBoundAnswerAttention = (record: AnswerOperationRecord): string =>
  `answer request ${record.requestId} for ${record.toolUseId} may have reached the form, and release was not confirmed; the bound question remains blocked and was not sent again`;

const unconfirmedOrphanAnswerAttention = (record: AnswerOperationRecord): string =>
  `answer request ${record.requestId} for ${record.toolUseId} may have reached the form, and release was not confirmed; inspect the session before continuing`;

const releasedAnswerAttention = (record: AnswerOperationRecord): string =>
  `answer request ${record.requestId} for ${record.toolUseId} may have reached the form; the form was released, so prose may continue, but the original answer remains unconfirmed`;

/**
 * The released advisory as the composition root raises it, BEFORE its own ledger append.
 *
 * That first write happens when the state write which should have released a visibly advanced form
 * failed, so there is no settled record to name yet and the sentence carries no request id. It is
 * exported for that one caller: the wording has to be written from here, or the projector's
 * ownership check would be comparing against a copy it does not own and a later authoritative
 * confirmation could never clear that first write.
 */
export function firstWriteReleasedAnswerAttention(toolUseId: string): string {
  return `an answer to ${toolUseId} may have reached the form and was never confirmed; the form was released, so prose may continue, but do not assume the original answer landed`;
}

const unconfirmedAttentionOwnedBy = (state: SessionState, record: AnswerOperationRecord): boolean =>
  state.needsHumanKind === STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND &&
  (state.needsHuman === unconfirmedBoundAnswerAttention(record) ||
    state.needsHuman === unconfirmedOrphanAnswerAttention(record));

/**
 * Does the RELEASED answer advisory standing on this session belong to THIS ledger record?
 *
 * The one ownership question an acknowledgment path may ask, and the only kind it may ask about:
 * the blocking `structured-answer-unconfirmed` state is deliberately not an owner here, because it
 * never clears through a relaunch. Ownership is exact message identity against what this daemon
 * would have written for that record — including the composition root's first write, which raises
 * the advisory before its own ledger append and so names no request id — which means it holds for
 * any non-empty tool or request id, whitespace and the message's own delimiter words included, and
 * answers false for every message this daemon would not have written.
 */
export function releasedAnswerAttentionOwnedBy(state: SessionState, record: AnswerOperationRecord): boolean {
  return (
    state.needsHumanKind === STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND &&
    (state.needsHuman === releasedAnswerAttention(record) ||
      state.needsHuman === firstWriteReleasedAnswerAttention(record.toolUseId))
  );
}

const answerAttentionOwnedBy = (state: SessionState, record: AnswerOperationRecord): boolean =>
  unconfirmedAttentionOwnedBy(state, record) || releasedAnswerAttentionOwnedBy(state, record);

// The tool-level questions this projector asks are that same predicate over the records it holds,
// and they demand EXACTLY ONE owner. Ownership is a fact about a record, so a tool owns the
// attention only through one of its records — but a rendered sentence is not an injective encoding
// of the pair that built it: `requestId 'r'` with `toolUseId 't for u'` and `requestId 'r for t'`
// with `toolUseId 'u'` render the identical message, and the first write renders the same sentence
// for every request id that ever named its tool. Finding one owner and stopping would let a
// confirmation or an acknowledgement of one of them clear an advisory that belongs to the other, so
// more than one owner fails closed to NOT owned: nothing is cleared on ambiguous evidence, and the
// projector re-asserts the attention for the record it is actually projecting.
const attentionOwnedForTool = (
  state: SessionState,
  toolUseId: string | undefined,
  records: readonly AnswerOperationRecord[],
  owned: (state: SessionState, record: AnswerOperationRecord) => boolean,
): boolean => {
  if (toolUseId === undefined) return false;
  const owners = records.filter(record => owned(state, record));
  return owners.length === 1 && owners[0]?.toolUseId === toolUseId;
};

const unresolvedAnswerAttentionFor = (
  state: SessionState,
  toolUseId: string | undefined,
  records: readonly AnswerOperationRecord[],
): boolean => attentionOwnedForTool(state, toolUseId, records, unconfirmedAttentionOwnedBy);

const releasedAnswerAttentionFor = (
  state: SessionState,
  toolUseId: string | undefined,
  records: readonly AnswerOperationRecord[],
): boolean => attentionOwnedForTool(state, toolUseId, records, releasedAnswerAttentionOwnedBy);

const ownedAnswerAttentionFor = (
  state: SessionState,
  toolUseId: string | undefined,
  records: readonly AnswerOperationRecord[],
): boolean => attentionOwnedForTool(state, toolUseId, records, answerAttentionOwnedBy);

/**
 * What a READ may retire because the ledger holds an acknowledgement: the blocking state, and only
 * the blocking state.
 *
 * A standing RELEASED advisory has exactly ONE clear owner, and it is not this projector: the resume
 * service clears it as the last step of a successful bare human-admin relaunch, holding the same
 * answer executor it appended the acknowledgement under. Retiring it from a read would make a second
 * owner out of a projection — and worse, a self-defeating one. The acknowledgement is durable, so a
 * daemon that crashed in that gap re-reads it on the next boot: clearing the advisory there turns the
 * session back into an ordinary live one, and the retry the acknowledgement exists for is refused
 * because the released exemption is exactly what let a bare relaunch through. Suppressing the RE-MINT
 * is this projector's whole job for an acknowledged tool (see `acknowledgedTool`); the clear is not.
 */
const acknowledgementClears = (
  state: SessionState,
  toolUseId: string | undefined,
  records: readonly AnswerOperationRecord[],
): boolean => unresolvedAnswerAttentionFor(state, toolUseId, records);

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
    // A TOOL RESULT IS THE ONLY RELEASE EVIDENCE A TAIL CARRIES. A terminal `turn` event is
    // deliberately not one: an aborted or completed turn says nothing about the pane, so it cannot
    // prove the selector stopped being drawn. Reconciliation would convert that identity into the
    // prose-permitting released advisory, which is exactly how prose could reach a live form, so an
    // unresolved question stays pending until a result or a positive pane observation releases it.
    if (event.kind === 'tool-result' && pending?.toolUseId === event.result.callId) {
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
      !ownedAnswerAttentionFor(current, toolUseId, records)
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
      ...(ownedAnswerAttentionFor(current, toolUseId, records) ? clearAnswerAttention : {}),
    };
  }
  if (evidence.kind === 'quarantined') {
    if (
      newerQuestion === undefined &&
      current.pendingQuestion === undefined &&
      releasedAnswerAttentionFor(current, evidence.record.toolUseId, records)
    )
      return {};
    return {
      pendingQuestion: newerQuestion,
      status: terminal ? current.status : newerQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
      needsHuman: releasedAnswerAttention(evidence.record),
      ...(evidence.record.reason === undefined ? {} : { reason: evidence.record.reason }),
    };
  }
  if (evidence.kind === 'released' || evidence.kind === 'acknowledged') {
    const clearOwnedAttention =
      evidence.kind === 'acknowledged'
        ? acknowledgementClears(current, toolUseId, records)
        : ownedAnswerAttentionFor(current, toolUseId, records);
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
      unresolvedAnswerAttentionFor(current, evidence.record.toolUseId, records)
    )
      return {};
    return {
      pendingQuestion: boundQuestion,
      status: terminal ? current.status : boundQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: unconfirmedBoundAnswerAttention(evidence.record),
      ...(evidence.record.reason === undefined ? {} : { reason: evidence.record.reason }),
    };
  }

  const acknowledgedTool = (toolUseId: string): boolean =>
    records.some(record => record.outcome === 'acknowledged' && record.toolUseId === toolUseId);

  // An explicit human relaunch acknowledges the append-only predecessors OF ITS OWN TOOL. When that
  // tool's transcript identity has already slid out of the tail, retire the BLOCKING state by the
  // ledger fact rather than re-minting it from the older quarantine on the next read. Two narrowings
  // make that safe: it may retire only attention it actually owns, because an acknowledgement of one
  // tool is silence about a later one, and only the blocking kind, because the released advisory is
  // the resume service's to clear (`acknowledgementClears`). With neither, this falls through — the
  // advisory keeps standing and no later record re-mints it.
  const orphanAcknowledgement = records.find(
    record =>
      record.outcome === 'acknowledged' &&
      current.lastAnsweredQuestionToolUseId !== record.toolUseId &&
      acknowledgementClears(current, record.toolUseId, records),
  );
  if (orphanAcknowledgement !== undefined) {
    const pendingQuestion = projection.kind === 'pending' ? projection.question : undefined;
    return {
      pendingQuestion,
      status: terminal
        ? current.status
        : pendingQuestion === undefined
          ? current.status === 'awaiting_question'
            ? 'awaiting_user'
            : current.status
          : 'awaiting_question',
      ...clearAnswerAttention,
    };
  }

  // Monitor reconciliation normally turns an accepted predecessor into a quarantine before this
  // patch runs. If the durable state no longer names that predecessor, still restore its operator
  // attention while allowing a genuinely newer question to remain answerable — unless a human
  // already acknowledged that same tool, which is the one fact that closes it for good.
  const orphanQuarantine =
    evidence.kind === 'none'
      ? records.find(
          record =>
            record.outcome === 'quarantined' &&
            current.lastAnsweredQuestionToolUseId !== record.toolUseId &&
            !acknowledgedTool(record.toolUseId),
        )
      : undefined;
  if (orphanQuarantine !== undefined) {
    const pendingQuestion = projection.kind === 'pending' ? projection.question : undefined;
    const attentionStanding = releasedAnswerAttentionFor(current, orphanQuarantine.toolUseId, records);
    if (pendingQuestion === undefined && current.pendingQuestion === undefined && attentionStanding) return {};
    return {
      pendingQuestion,
      status: terminal ? current.status : pendingQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      ...(attentionStanding
        ? {}
        : {
            needsHumanKind: STRUCTURED_ANSWER_RELEASED_ATTENTION_KIND,
            needsHuman: releasedAnswerAttention(orphanQuarantine),
          }),
      ...(orphanQuarantine.reason === undefined ? {} : { reason: orphanQuarantine.reason }),
    };
  }

  // An accepted operation whose old form is no longer the projected/current one is still unresolved.
  // A newer question is not permission to forget that keys may have landed on its predecessor.
  const orphan = records.find(
    record =>
      record.outcome === 'accepted' &&
      current.lastAnsweredQuestionToolUseId !== record.toolUseId &&
      !acknowledgedTool(record.toolUseId),
  );
  if (orphan !== undefined) {
    const pendingQuestion = projection.kind === 'pending' ? projection.question : undefined;
    if (
      current.pendingQuestion?.toolUseId === pendingQuestion?.toolUseId &&
      unresolvedAnswerAttentionFor(current, orphan.toolUseId, records)
    )
      return {};
    return {
      pendingQuestion,
      status: terminal ? current.status : pendingQuestion === undefined ? 'awaiting_user' : 'awaiting_question',
      needsHumanKind: STRUCTURED_ANSWER_UNCONFIRMED_ATTENTION_KIND,
      needsHuman: unconfirmedOrphanAnswerAttention(orphan),
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
        // A newer question does not give a read the released advisory's clear either: an
        // acknowledged older tool keeps its advisory standing here for the same reason
        // (`acknowledgementClears`), while its re-mint stays suppressed.
        (record.outcome === 'acknowledged'
          ? acknowledgementClears(current, record.toolUseId, records)
          : ownedAnswerAttentionFor(current, record.toolUseId, records)),
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
