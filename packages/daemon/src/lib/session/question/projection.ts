import type { PendingQuestion, SessionState } from '@ferretry/protocol';
import type { TranscriptEvent, TranscriptQuestion } from '../../transcript/types.ts';

export type StructuredQuestionProjection =
  | { readonly kind: 'none' }
  | { readonly kind: 'pending'; readonly question: PendingQuestion }
  | { readonly kind: 'needs-human'; readonly reason: string };

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
    if (event.kind === 'tool-result' && pending?.toolUseId === event.result.callId) pending = undefined;
    if (event.kind === 'turn' && (event.state === 'completed' || event.state === 'aborted')) pending = undefined;
  }
  return pending === undefined ? { kind: 'none' } : { kind: 'pending', question: pending };
}

/** State patch for a projection.  It is intentionally partial: storage keeps timestamps and other monitor evidence. */
export function structuredQuestionStatePatch(
  current: SessionState,
  projection: StructuredQuestionProjection,
): Partial<SessionState> {
  if (projection.kind === 'pending' && current.lastAnsweredQuestionToolUseId === projection.question.toolUseId)
    return {};
  if (projection.kind === 'pending')
    return {
      pendingQuestion: projection.question,
      status:
        current.status === 'completed' || current.status === 'stopped' || current.status === 'failed'
          ? current.status
          : 'awaiting_question',
      ...(current.needsHumanKind === 'structured-question-unrecognized' ? { needsHumanKind: undefined } : {}),
    };
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
