import type { AnswerRequest, Question } from '../../../contract/index.ts';
import type { ConversationOutput } from '../send/ports.ts';
import { type AnswerFlags, planAnswer } from './plan.ts';

export interface AnswerGateway {
  /** The question the ferret is waiting on, or none. */
  question(ferret: string): Promise<Question | undefined>;
  answer(ferret: string, request: AnswerRequest): Promise<void>;
  interrupt(ferret: string): Promise<void>;
}

export interface AnswerCommandFlags extends AnswerFlags {
  readonly json?: boolean;
}

/** Answers a ferret's structured question: `fy answer`. */
export class AnswerQuestionController {
  constructor(
    private readonly gateway: AnswerGateway,
    private readonly output: ConversationOutput,
  ) {}

  async execute(ferret: string, flags: AnswerCommandFlags): Promise<void> {
    const plan = planAnswer(flags, await this.gateway.question(ferret));
    await this.gateway.answer(ferret, {
      toolUseId: plan.toolUseId,
      labels: plan.labels,
      ...(plan.other === undefined ? {} : { other: plan.other }),
      ...(plan.responses === undefined ? {} : { responses: plan.responses }),
    });
    this.output.out(
      flags.json === true ? JSON.stringify({ ferret, answered: plan.toolUseId }, null, 2) : `${ferret}: answered`,
    );
  }
}

/** Interrupts a ferret's active turn so it can be steered: `fy interrupt`. */
export class InterruptController {
  constructor(
    private readonly gateway: AnswerGateway,
    private readonly output: ConversationOutput,
  ) {}

  async execute(ferret: string, flags: { readonly json?: boolean } = {}): Promise<void> {
    await this.gateway.interrupt(ferret);
    this.output.out(
      flags.json === true ? JSON.stringify({ ferret, interrupted: true }, null, 2) : `${ferret}: interrupted`,
    );
  }
}
