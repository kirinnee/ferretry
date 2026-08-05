import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import type { StructuredQuestionDriver } from '../../../lib/session/question/service.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { PaneState } from '../../../lib/tmux/contracts.ts';

/** The narrow pane seam the structured answer driver needs from tmux. */
export interface StructuredQuestionPane {
  state(session: string): Promise<PaneState>;
  sendKey(session: string, key: string): Promise<void>;
  paste(session: string, text: string): Promise<void>;
}

export class StructuredQuestionDriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredQuestionDriveError';
  }
}

const cursor = /^[\s]*[❯>➜▶][\s]*(?:\[([ xX])\][\s]*)?(.*)$/u;
const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();

function cursorAt(pane: string, labels: readonly string[]): number | undefined {
  for (const line of pane.split('\n')) {
    const match = cursor.exec(line);
    if (match === null) continue;
    const index = labels.indexOf(compact(match[2] ?? ''));
    if (index >= 0) return index;
  }
  return undefined;
}

function visibleQuestion(pane: string, question: PendingQuestion['questions'][number]): boolean {
  if (!pane.includes(question.question)) return false;
  const labels = question.options?.map(option => compact(option.label)) ?? [];
  return labels.length > 0 && labels.every(label => pane.includes(label));
}

/** Drives only a positively bound visible selector and waits for it to advance. */
export class TmuxStructuredQuestionDriver implements StructuredQuestionDriver {
  constructor(
    private readonly tmux: StructuredQuestionPane,
    private readonly session: (id: SessionId) => Promise<string>,
    private readonly sleep: (milliseconds: number) => Promise<void>,
    private readonly polls = 12,
    private readonly pollMs = 250,
  ) {}

  async drive(
    id: SessionId,
    pending: PendingQuestion,
    answers: readonly StructuredQuestionAnswer[],
  ): Promise<{ readonly confirmedBy: 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced' }> {
    const session = await this.session(id);
    let confirmation: 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced' = 'pane-advanced';
    for (let index = 0; index < pending.questions.length; index++) {
      const question = pending.questions[index];
      const answer = answers[index];
      if (question === undefined || answer === undefined)
        throw new StructuredQuestionDriveError(`question ${index + 1} vanished before it could be driven`);
      const before = await this.tmux.state(session);
      if (!before.alive || before.dead) throw new StructuredQuestionDriveError('session pane is dead; use resume');
      if (!visibleQuestion(before.visible, question))
        throw new StructuredQuestionDriveError(
          'the rendered form is not the exact pending question; no keys were sent',
        );
      const labels = question.options?.map(option => compact(option.label)) ?? [];
      const start = cursorAt(before.visible, labels);
      if (start === undefined)
        throw new StructuredQuestionDriveError('the form cursor is not visible; a selection origin cannot be guessed');
      const choices = answer.kind === 'selection' ? answer.labels.map(compact) : ['Other'];
      if (choices.some(label => !labels.includes(label)))
        throw new StructuredQuestionDriveError('the requested answer is not an option in the bound rendered form');
      let at = start;
      for (const label of choices) {
        const target = labels.indexOf(label);
        const key = target >= at ? 'Down' : 'Up';
        for (let step = 0; step < Math.abs(target - at); step++) await this.tmux.sendKey(session, key);
        at = target;
        if (question.multiSelect === true) await this.tmux.sendKey(session, 'Space');
      }
      await this.tmux.sendKey(session, 'Enter');
      if (answer.kind === 'other') {
        await this.waitForChangedQuestionPage(session, before.visible, question.question);
        await this.tmux.paste(session, answer.text);
        await this.tmux.sendKey(session, 'Enter');
      }
      confirmation = await this.waitForAdvance(session, pending, index, before.visible);
    }
    return { confirmedBy: confirmation };
  }

  private async waitForChangedQuestionPage(session: string, before: string, question: string): Promise<void> {
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      const state = await this.tmux.state(session);
      if (!state.alive || state.dead)
        throw new StructuredQuestionDriveError('session pane died while opening free-form input');
      if (state.visible !== before && state.visible.includes(question)) return;
    }
    throw new StructuredQuestionDriveError('selecting Other did not produce a bound free-form page');
  }

  private async waitForAdvance(
    session: string,
    pending: PendingQuestion,
    index: number,
    before: string,
  ): Promise<'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced'> {
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      const state = await this.tmux.state(session);
      if (!state.alive || state.dead)
        throw new StructuredQuestionDriveError('session pane died while confirming the structured answer');
      const next = pending.questions[index + 1];
      if (next !== undefined && visibleQuestion(state.visible, next)) return 'next-question';
      const anyQuestion = pending.questions.some(question => visibleQuestion(state.visible, question));
      if (!anyQuestion && state.promptReady) return 'prompt-ready';
      if (!anyQuestion && state.visible !== before) return 'pane-advanced';
    }
    throw new StructuredQuestionDriveError('the answer keys were sent, but the rendered form did not visibly advance');
  }
}
