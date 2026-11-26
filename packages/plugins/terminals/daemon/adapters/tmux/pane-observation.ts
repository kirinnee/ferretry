import type { RunnerPaneObservation } from '@ferretry/core-ferrets/contract';
import type { Redaction } from '@ferretry/kernel/contract';
import type { TmuxCommandPort } from '../../lib/tmux/contracts.ts';
import type { TmuxController } from '../../lib/tmux/controller.ts';
import type { TypingHold } from '../../lib/session/console/index.ts';
import { ComposerActs } from './composer-acts.ts';

/** What one observation reads besides the pane itself. */
export interface PaneObservationPorts {
  readonly tmux: TmuxCommandPort;
  /** Masks a blocking prompt's words; absent, a fixed sentence stands in. */
  readonly redaction?: Redaction | undefined;
  /** Whether a person is typing: the one hold the send path's draft guard reads as `typing`. */
  readonly typing?: TypingHold | undefined;
}

/** A blocking prompt's words, masked inside one `Redaction.read`; with no redaction bound, a fixed sentence. */
async function masked(seen: RunnerPaneObservation, redaction: Redaction | undefined): Promise<RunnerPaneObservation> {
  const { blockingPrompt, ...rest } = seen;
  if (blockingPrompt === undefined) return seen;
  if (redaction === undefined) return { ...rest, blockingPrompt: 'a prompt on its screen' };
  const [words] = await redaction.read(scope => scope.lines([blockingPrompt]));
  return { ...rest, blockingPrompt: words ?? 'a prompt on its screen' };
}

/**
 * One read of a pane for a send: the composer and the screen, the blocking prompt masked, and `typing` when a person
 * has pressed a key in this pane within the hold (the Console's keys, or a client attached with `tmux attach`).
 */
export async function observePane(
  ports: PaneObservationPorts,
  reading: { readonly tmux: TmuxController; readonly session: string },
  paneId: string,
): Promise<RunnerPaneObservation> {
  const seen = await new ComposerActs(reading.tmux, reading.session, async () => undefined).observe();
  const typing = (await ports.typing?.held(ports.tmux, paneId, reading.session)) === true;
  return await masked(typing ? { ...seen, typing } : seen, ports.redaction);
}
