import { type AnswerFlags, planAnswer } from './answer-plan.ts';
import type { ISessionApi } from './ports.ts';
import type { SessionPresenter } from './presenter.ts';

export interface AnswerCommandFlags extends AnswerFlags {
  readonly json?: boolean;
}

/** Answers a session's structured question: `fy answer`. */
export class AnswerQuestionController {
  constructor(
    private readonly api: ISessionApi,
    private readonly presenter: SessionPresenter,
  ) {}

  async execute(id: string, flags: AnswerCommandFlags): Promise<void> {
    const plan = planAnswer(flags, (await this.api.get(id)).state.pendingQuestion);
    const view = await this.api.answer(id, plan.toolUseId, plan.labels, plan.other, plan.responses);
    this.presenter.view(view, flags.json === true);
  }
}
