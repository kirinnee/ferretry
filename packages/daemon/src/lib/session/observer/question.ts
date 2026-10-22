import type { SessionState } from '@ferretry/protocol';
import type { TranscriptEvent } from '../../transcript/types.ts';
import { type ObservedRuntime, observedRuntimeStatePatch, projectObservedRuntime } from '../harness/observation.ts';
import { type AnswerOperationRecord, reconcileAnswerEvidence } from '../question/answer-ledger.ts';
import {
  projectStructuredQuestion,
  type StructuredQuestionProjection,
  structuredQuestionStatePatch,
} from '../question/projection.ts';
import { DEFAULT_TRANSCRIPT_TAIL } from '../transcript/reader.ts';

/** How much of a transcript's end the question part reads: any in-flight question sits inside it. */
export const QUESTION_TAIL_EVENTS = DEFAULT_TRANSCRIPT_TAIL;

/** What one question look found: the session's document, its transcript tail and its answer receipts. */
export interface QuestionLook {
  readonly state: SessionState;
  readonly events: readonly TranscriptEvent[];
  /** The answer ledger, by request id. */
  readonly answers: ReadonlyMap<string, AnswerOperationRecord>;
}

/**
 * The question part's patch: everything the writer needs to re-decide the state change UNDER the
 * session's lock, plus the receipts reconciliation settled.
 *
 * It carries the projections rather than a finished state patch on purpose. A lifecycle stop can commit
 * after the look but before the write; applying a patch computed from the look would resurrect its
 * `kill_failed` as `awaiting_question`. So the writer recomputes from these against the document it
 * holds the lock on — see {@link questionDocumentPatch}.
 */
export interface QuestionPatch {
  readonly kind: 'question';
  readonly projection: StructuredQuestionProjection;
  /** The answer receipts after reconciliation, which the state patch is decided against. */
  readonly records: readonly AnswerOperationRecord[];
  /** Receipts reconciliation promoted: appended to the ledger before the state is written. */
  readonly settlements: readonly AnswerOperationRecord[];
  readonly runtime: ObservedRuntime;
  /** Whether the look implied any state change at all; when not, the document is not rewritten. */
  readonly writes: boolean;
}

/**
 * The question and observed-runtime patch one look implies, or `undefined` when it implies nothing —
 * no receipt to settle and no field to change.
 *
 * TWO PROJECTIONS OVER ONE TAIL, not two reads. The open structured question and the harness's own
 * account of which model it is running are both recovered from the same events, and both are additive
 * over whatever the document already holds, so neither can erase the other's fields.
 */
export function stepQuestion(look: QuestionLook): QuestionPatch | undefined {
  const projection = projectStructuredQuestion(look.events);
  const answerEvidence = reconcileAnswerEvidence(look.answers, look.state, {
    ...(projection.kind === 'pending' ? { activeToolUseId: projection.question.toolUseId } : {}),
    ...(projection.kind === 'resolved' ? { resolvedToolUseId: projection.toolUseId } : {}),
  });
  const records = [...answerEvidence.records.values()];
  const runtime = projectObservedRuntime(look.events);
  // The model the harness SAID it was using, never the one the session was launched with. Nothing else
  // in the daemon writes these fields, so every surface that shows a running model is reading this.
  const writes =
    Object.keys({
      ...structuredQuestionStatePatch(look.state, projection, records),
      ...observedRuntimeStatePatch(look.state, runtime),
    }).length > 0;
  if (!writes && answerEvidence.settlements.length === 0) return undefined;
  return { kind: 'question', projection, records, settlements: answerEvidence.settlements, runtime, writes };
}

/** The fields a question patch may remove from the document — and only when the projection names them. */
type RemovableQuestionField = 'pendingQuestion' | 'needsHumanKind' | 'needsHuman';
const REMOVABLE: readonly RemovableQuestionField[] = ['pendingQuestion', 'needsHumanKind', 'needsHuman'];

/** A state change decided under the lock: fields to lay over the document and fields to remove from it. */
export interface QuestionDocumentPatch {
  readonly fields: Partial<SessionState>;
  readonly removals: readonly RemovableQuestionField[];
}

/**
 * The patch re-decided against the document the writer holds the lock on, or `undefined` when that
 * document already says it all.
 *
 * Removals belong to the QUESTION projection alone and only when it explicitly names the field. A model
 * observation must never erase a picker or answer quarantine.
 */
export function questionDocumentPatch(current: SessionState, patch: QuestionPatch): QuestionDocumentPatch | undefined {
  const question = structuredQuestionStatePatch(current, patch.projection, patch.records);
  const fields = { ...question, ...observedRuntimeStatePatch(current, patch.runtime) };
  if (Object.keys(fields).length === 0) return undefined;
  return {
    fields,
    removals: REMOVABLE.filter(field => Object.hasOwn(question, field) && question[field] === undefined),
  };
}
