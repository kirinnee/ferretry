import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';
import {
  type StructuredQuestionCancellation,
  StructuredQuestionDriveFailure,
  type StructuredQuestionDriver,
} from '../../../lib/session/question/service.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import type { PaneState } from '../../../lib/tmux/contracts.ts';
import { paneShowsActiveWork } from '../../../lib/tmux/pane.ts';

/** The narrow pane seam the structured answer driver needs from tmux. */
export interface StructuredQuestionPane {
  state(session: string): Promise<PaneState>;
  sendKey(session: string, key: string): Promise<void>;
  paste(session: string, text: string): Promise<void>;
}

export class StructuredQuestionDriveError extends StructuredQuestionDriveFailure {
  constructor(
    message: string,
    acceptance: 'none' | 'ambiguous' = 'none',
    diagnostics: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, acceptance, diagnostics);
    this.name = 'StructuredQuestionDriveError';
  }
}

const cursor = /^[\s]*[❯>➜▶][\s]*(?:\[([ xX])\][\s]*)?(.*)$/u;
const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();

function cursorAt(pane: string, labels: readonly string[]): number | undefined {
  for (const line of pane.split('\n')) {
    const match = cursor.exec(line);
    if (match === null) continue;
    const rendered = compact(match[2] ?? '');
    const index = labels.findIndex(
      label => label === rendered || (label === 'Other' && /^other(?:…|\.\.\.)?(?:\s|$)/iu.test(rendered)),
    );
    if (index >= 0) return index;
  }
  return undefined;
}

function renderedLabels(pane: string, question: PendingQuestion['questions'][number]): string[] {
  const labels = question.options?.map(option => compact(option.label)) ?? [];
  // Both supported harnesses render a native free-form row even though the transcript tool input
  // carries only the caller-authored options. The PWA exposes that same row, so bind it from the
  // actual pane rather than inventing it when the harness did not render one.
  if (
    !labels.includes('Other') &&
    pane.split('\n').some(line => /^\s*(?:[○◯◉●]\s*)?other(?:…|\.\.\.)?(?:\s|$)/iu.test(line))
  )
    labels.push('Other');
  return labels;
}

function visibleQuestion(pane: string, question: PendingQuestion['questions'][number]): boolean {
  const visible = compact(pane);
  if (!visible.includes(compact(question.question))) return false;
  const labels = question.options?.map(option => compact(option.label)) ?? [];
  return labels.length > 0 && labels.every(label => visible.includes(label));
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
    let mayHaveAccepted = false;
    try {
      const session = await this.session(id);
      const sendKey = async (key: string): Promise<void> => {
        // Set before awaiting tmux: a command that loses its response may still have delivered input.
        mayHaveAccepted = true;
        await this.tmux.sendKey(session, key);
      };
      const paste = async (text: string): Promise<void> => {
        mayHaveAccepted = true;
        await this.tmux.paste(session, text);
      };
      let confirmation: 'next-question' | 'turn-started' | 'prompt-ready' | 'pane-advanced' = 'pane-advanced';
      for (let index = 0; index < pending.questions.length; index++) {
        const question = pending.questions[index];
        const answer = answers[index];
        if (question === undefined || answer === undefined)
          throw new StructuredQuestionDriveError(`question ${index + 1} vanished before it could be driven`, 'none', {
            phase: 'preflight',
            questionIndex: index,
          });
        const before = await this.tmux.state(session);
        if (!before.alive || before.dead)
          throw new StructuredQuestionDriveError('session pane is dead; use resume', 'none', {
            phase: 'preflight',
            questionIndex: index,
            paneAlive: before.alive,
            paneDead: before.dead,
          });
        if (!visibleQuestion(before.visible, question))
          throw new StructuredQuestionDriveError(
            'the rendered form is not the exact pending question; no keys were sent',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'question-unbound' },
          );
        const labels = renderedLabels(before.visible, question);
        const start = cursorAt(before.visible, labels);
        if (start === undefined)
          throw new StructuredQuestionDriveError(
            'the form cursor is not visible; a selection origin cannot be guessed',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'cursor-missing' },
          );
        const choices = answer.kind === 'selection' ? answer.labels.map(compact) : ['Other'];
        if (choices.some(label => !labels.includes(label)))
          throw new StructuredQuestionDriveError(
            'the requested answer is not an option in the bound rendered form',
            'none',
            { phase: 'preflight', questionIndex: index, reason: 'choice-missing' },
          );
        let at = start;
        for (const label of choices) {
          const target = labels.indexOf(label);
          const key = target >= at ? 'Down' : 'Up';
          for (let step = 0; step < Math.abs(target - at); step++) await sendKey(key);
          at = target;
          if (question.multiSelect === true) await sendKey('Space');
        }
        await sendKey('Enter');
        if (answer.kind === 'other') {
          await this.waitForChangedQuestionPage(session, before.visible, question.question);
          await paste(answer.text);
          await sendKey('Enter');
        }
        confirmation = await this.waitForAdvance(session, pending, index, before.visible);
      }
      return { confirmedBy: confirmation };
    } catch (error) {
      if (error instanceof StructuredQuestionDriveFailure) {
        if (!mayHaveAccepted || error.acceptance === 'ambiguous') throw error;
        throw new StructuredQuestionDriveError(error.message, 'ambiguous', error.diagnostics);
      }
      throw new StructuredQuestionDriveError(
        error instanceof Error ? error.message : String(error),
        mayHaveAccepted ? 'ambiguous' : 'none',
        { phase: mayHaveAccepted ? 'drive' : 'preflight' },
      );
    }
  }

  /** Best-effort release after a failed drive: positively bind, send one Escape, then prove advance. */
  async cancel(id: SessionId, pending: PendingQuestion): Promise<StructuredQuestionCancellation> {
    const session = await this.session(id);
    let current = await this.tmux.state(session);
    if (!current.alive || current.dead)
      throw new StructuredQuestionDriveError('session pane is dead; use resume', 'none', {
        phase: 'cancel-preflight',
      });
    const visible = (pane: PaneState): boolean =>
      pending.questions.some(question => visibleQuestion(pane.visible, question));
    const advanced = (
      pane: PaneState,
      allowActiveWork: boolean,
    ): StructuredQuestionCancellation['confirmedBy'] | undefined => {
      if (visible(pane)) return undefined;
      if (pane.promptReady) return 'prompt-ready';
      // Active-work text is meaningful only after this method positively bound the form and sent
      // Escape. Before that, the form's own "esc to interrupt" footer describes the blocked tool
      // call and is not evidence that the modal advanced.
      if (allowActiveWork && paneShowsActiveWork(pane.visible)) return 'turn-started';
      return undefined;
    };
    const already = advanced(current, false);
    if (already !== undefined) return { confirmedBy: 'already-advanced', pane: current };
    if (!visible(current))
      throw new StructuredQuestionDriveError(
        'the failed answer no longer has a positively bound question menu; refusing automatic Escape',
        'none',
        { phase: 'cancel-preflight', reason: 'question-unbound' },
      );
    const before = current.visible;
    // Exactly once. A failed tmux response is not permission to send another Escape.
    await this.tmux.sendKey(session, 'Escape');
    for (let poll = 0; poll < this.polls; poll++) {
      await this.sleep(this.pollMs);
      current = await this.tmux.state(session);
      if (!current.alive || current.dead)
        throw new StructuredQuestionDriveError('session pane died while releasing the structured question', 'none', {
          phase: 'cancel-confirm',
        });
      const confirmation = advanced(current, true);
      if (confirmation !== undefined) return { confirmedBy: confirmation, pane: current };
      if (!visible(current) && current.visible !== before) return { confirmedBy: 'pane-advanced', pane: current };
    }
    throw new StructuredQuestionDriveError('Escape was sent, but the question pane did not visibly advance', 'none', {
      phase: 'cancel-confirm',
    });
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
      if (!anyQuestion && paneShowsActiveWork(state.visible)) return 'turn-started';
      if (!anyQuestion && state.promptReady) return 'prompt-ready';
      if (!anyQuestion && state.visible !== before) return 'pane-advanced';
    }
    throw new StructuredQuestionDriveError('the answer keys were sent, but the rendered form did not visibly advance');
  }
}
