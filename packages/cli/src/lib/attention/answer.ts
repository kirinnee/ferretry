import type { AttentionResponse } from '@ferretry/protocol';

/** The flags that carry a human's answer to an ask. */
export interface AnswerFlags {
  readonly approve?: boolean;
  readonly reject?: boolean;
  readonly choice?: string;
  readonly good?: boolean;
  readonly clarify?: string;
  readonly answer?: string;
}

const ONE_ANSWER = 'give exactly one answer: --approve/--reject, --choice, --good/--clarify, or --answer';

/**
 * Read the answer a `attention done` carries, or nothing when the item had no ask.
 *
 * Every conflicting combination is refused here rather than sent: the daemon would reject a response
 * whose kind does not match the ask anyway, and a local message can name the flag that clashed.
 */
export function parseAnswer(flags: AnswerFlags): AttentionResponse | undefined {
  const permission = flags.approve === true || flags.reject === true;
  const review = flags.good === true || flags.clarify !== undefined;
  const chosen = [permission, flags.choice !== undefined, review, flags.answer !== undefined].filter(Boolean).length;

  if (chosen === 0) return undefined;
  if (chosen > 1) throw new Error(ONE_ANSWER);
  if (flags.approve === true && flags.reject === true) throw new Error(ONE_ANSWER);
  if (flags.good === true && flags.clarify !== undefined) throw new Error(ONE_ANSWER);

  if (permission) return { kind: 'permission', decision: flags.approve === true ? 'approve' : 'reject' };
  if (flags.choice !== undefined)
    return { kind: 'multiple-choice', choice: required(flags.choice, '--choice', 'the label of one listed option') };
  if (flags.good === true) return { kind: 'answer-review', verdict: 'good' };
  if (flags.clarify !== undefined) {
    return {
      kind: 'answer-review',
      verdict: 'clarify',
      clarification: required(flags.clarify, '--clarify', 'the clarification text'),
    };
  }
  return { kind: 'open-question', answer: required(flags.answer ?? '', '--answer', 'the answer text') };
}

/** Describe a recorded answer for the history listing. */
export function describeAnswer(response: AttentionResponse): string {
  switch (response.kind) {
    case 'permission':
      return response.decision === 'approve' ? 'approved' : 'rejected';
    case 'multiple-choice':
      return `chose "${response.choice}"`;
    case 'answer-review':
      return response.verdict === 'good' ? 'answer accepted' : `clarification requested: ${response.clarification}`;
    case 'open-question':
      return `answered: ${response.answer}`;
  }
}

function required(value: string, flag: string, what: string): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new Error(`${flag} needs ${what}`);
  return trimmed;
}
