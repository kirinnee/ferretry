import { CommandError } from '../errors.ts';

/** The `answer` flags, already parsed out of argv by the composition root. */
export interface AnswerFlags {
  /** The question's tool call, as the ferret asked it (`--question <id>`): the daemon answers only that one. */
  readonly toolUseId?: string;
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

/** Validates an answer before anything is sent: something was chosen, and the question it answers is named. */
export function planAnswer(flags: AnswerFlags): AnswerPlan {
  const labels = [...(flags.labels ?? [])].filter(label => label.trim() !== '');
  const responses = [...(flags.responses ?? [])];
  if (labels.length === 0 && flags.other === undefined && responses.length === 0)
    throw new CommandError('provide labels, --other <text>, or one --response per question');
  const toolUseId = flags.toolUseId?.trim();
  if (toolUseId === undefined || toolUseId === '')
    throw new CommandError('name the question being answered with --question <id>', 2);
  return {
    toolUseId,
    labels,
    ...(flags.other === undefined ? {} : { other: flags.other }),
    ...(responses.length === 0 ? {} : { responses }),
  };
}
