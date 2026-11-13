import type { Question } from '../../../contract/index.ts';
import { CommandError } from '../errors.ts';

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
 * Validates an answer against the question actually pending, before anything is sent: something was chosen, a question
 * is waiting, and no more responses are given than questions asked (one, or the several of a tabbed form).
 */
export function planAnswer(flags: AnswerFlags, pending: Question | null | undefined): AnswerPlan {
  const labels = [...(flags.labels ?? [])].filter(label => label.trim() !== '');
  const responses = [...(flags.responses ?? [])];
  if (labels.length === 0 && flags.other === undefined && responses.length === 0)
    throw new CommandError('provide labels, --other <text>, or one --response per question');
  if (pending === undefined || pending === null)
    throw new CommandError('this ferret has no pending question to answer', 1);
  const asked = 1 + (pending.more?.length ?? 0);
  if (responses.length > asked)
    throw new CommandError(`this ferret asked ${asked} question(s); pass exactly one --response for each`);
  return {
    toolUseId: pending.toolUseId,
    labels,
    ...(flags.other === undefined ? {} : { other: flags.other }),
    ...(responses.length === 0 ? {} : { responses }),
  };
}
