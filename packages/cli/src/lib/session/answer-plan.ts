import type { PendingQuestion } from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';

/** The `answer` flags, already parsed out of argv by the composition root. */
export interface AnswerFlags {
  readonly labels?: readonly string[];
  readonly other?: string;
  readonly responses?: readonly string[];
}

export interface AnswerPlan {
  readonly toolUseId: string;
  readonly labels: string[];
  readonly other?: string;
  readonly responses?: string[];
}

/**
 * Validates an answer against the question actually pending.
 *
 * The source checked only that *something* was supplied and then let the daemon reject a mismatch,
 * so `answer <id> a b c` against a one-question prompt failed with a wire-level message. The count
 * is checked here, against the pending question, before anything is sent.
 */
export function planAnswer(flags: AnswerFlags, pending: PendingQuestion | null | undefined): AnswerPlan {
  const labels = [...(flags.labels ?? [])].filter(label => label.trim() !== '');
  const responses = [...(flags.responses ?? [])];
  if (labels.length === 0 && flags.other === undefined && responses.length === 0)
    throw new SessionCommandError('provide labels, --other <text>, or one --response per question');
  if (pending === undefined || pending === null)
    throw new SessionCommandError('this session has no pending question to answer', 1);
  if (responses.length > 0 && responses.length !== pending.questions.length)
    throw new SessionCommandError(
      `this session asked ${pending.questions.length} question(s); pass exactly one --response for each`,
    );

  return {
    toolUseId: pending.toolUseId,
    labels,
    ...(flags.other === undefined ? {} : { other: flags.other }),
    ...(responses.length === 0 ? {} : { responses }),
  };
}
