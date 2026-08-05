import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import type { SessionId } from '../../session-id.ts';

/** A question answer must be driven into the rendered harness form, not sent as prose. */
export interface StructuredQuestionDriver {
  drive(
    id: SessionId,
    question: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced' }>;
}

/** The durable state boundary.  The exact tool id is checked again under this boundary. */
export interface StructuredQuestionRepository {
  pending(id: SessionId): Promise<PendingQuestion | undefined>;
  answered(
    id: SessionId,
    toolUseId: string,
    answers: readonly StructuredQuestionAnswer[],
    confirmation: { readonly confirmedBy: string },
  ): Promise<void>;
}

export class StructuredQuestionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredQuestionRefused';
  }
}

function legacyAnswers(
  question: PendingQuestion,
  labels: readonly string[],
  other: string | undefined,
  responses: readonly string[] | undefined,
): StructuredQuestionAnswer[] {
  if (responses !== undefined) {
    if (responses.length !== question.questions.length)
      throw new StructuredQuestionRefused(`expected ${question.questions.length} answers, received ${responses.length}`);
    return responses.map((response, index) => {
      const item = question.questions[index]!;
      return item.options?.some(option => option.label === response)
        ? { kind: 'selection' as const, labels: [response] }
        : { kind: 'other' as const, text: response.trim() };
    });
  }
  if (question.questions.length !== 1)
    throw new StructuredQuestionRefused('a question set requires one answer for every displayed question');
  return other === undefined ? [{ kind: 'selection', labels: [...labels] }] : [{ kind: 'other', text: other.trim() }];
}

function validate(question: PendingQuestion, answers: readonly StructuredQuestionAnswer[]): StructuredQuestionAnswer[] {
  if (answers.length !== question.questions.length)
    throw new StructuredQuestionRefused(`expected ${question.questions.length} answers, received ${answers.length}`);
  return answers.map((answer, index) => {
    const item = question.questions[index]!;
    if (answer.kind === 'other') {
      if (answer.text.trim() === '') throw new StructuredQuestionRefused(`question ${index + 1} has an empty free-form answer`);
      return { kind: 'other', text: answer.text.trim() };
    }
    const labels = [...answer.labels];
    if (labels.length === 0) throw new StructuredQuestionRefused(`question ${index + 1} has no selected option`);
    if (new Set(labels).size !== labels.length) throw new StructuredQuestionRefused(`question ${index + 1} repeats an option`);
    if (item.multiSelect !== true && labels.length !== 1)
      throw new StructuredQuestionRefused(`question ${index + 1} accepts exactly one option`);
    const options = item.options ?? [];
    if (labels.some(label => !options.some(option => option.label === label)))
      throw new StructuredQuestionRefused(`question ${index + 1} names an option the rendered form did not offer`);
    return { kind: 'selection', labels };
  });
}

/**
 * Coordinates the only safe answer ordering: bind the stored question, drive the
 * live form, receive visible advance evidence, then clear the exact durable key.
 */
export class StructuredQuestionService {
  constructor(
    private readonly repository: StructuredQuestionRepository,
    private readonly driver: StructuredQuestionDriver,
  ) {}

  async answer(input: {
    readonly id: SessionId;
    readonly toolUseId: string;
    readonly labels: readonly string[];
    readonly other?: string | undefined;
    readonly responses?: readonly string[] | undefined;
    readonly answers?: readonly StructuredQuestionAnswer[] | undefined;
  }): Promise<void> {
    const pending = await this.repository.pending(input.id);
    if (pending === undefined) throw new StructuredQuestionRefused(`session ${input.id} has no pending structured question`);
    if (pending.toolUseId !== input.toolUseId)
      throw new StructuredQuestionRefused(
        `the displayed question changed before this answer arrived (expected ${input.toolUseId}, current ${pending.toolUseId})`,
      );
    const answers = validate(
      pending,
      input.answers === undefined ? legacyAnswers(pending, input.labels, input.other, input.responses) : input.answers,
    );
    const confirmation = await this.driver.drive(input.id, pending, answers);
    await this.repository.answered(input.id, pending.toolUseId, answers, confirmation);
  }
}
