import type { AutoResumeCandidate } from '../../../lib/session/auto-resume/types.ts';
import type { ExitedSessionTransition, SessionExitObservation } from '../../../lib/session/health/exit.ts';
import type { SessionExitPort } from '../../../lib/session/health/service.ts';
import type { ExitObserveOptions, SurveyedSession } from '../../../lib/session/health/types.ts';

/**
 * Remembers which sessions the FIRST self-check after boot settled because their terminal was gone.
 *
 * That is the one observation that means "this was running when the host went down": nobody settled
 * the session while the daemon was up, and its terminal is not there. A pane that dies on a
 * running daemon is settled by an ordinary tick instead, which is why recording stops the moment
 * {@link close} is called — a crash an hour later is a crash, not a reboot, and must not be
 * auto-resumed.
 *
 * Only a settle that actually landed is recorded (`settle` resolved true), and only the unrecorded
 * `gone` exit: a pane tmux kept with an exit status is an agent that ended on its own.
 */
export class BootExitRecorder implements SessionExitPort {
  private open = true;
  private readonly found: AutoResumeCandidate[] = [];

  constructor(
    private readonly inner: SessionExitPort,
    private readonly clock: { now(): string },
  ) {}

  observe(
    survey: readonly SurveyedSession[],
    options?: ExitObserveOptions,
  ): Promise<readonly SessionExitObservation[]> {
    return this.inner.observe(survey, options);
  }

  async settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean> {
    const settled = await this.inner.settle(observation, transition);
    if (settled && this.open && observation.exit.kind === 'gone' && transition.status === 'failed')
      this.found.push({ id: observation.id, status: observation.status, at: this.clock.now() });
    return settled;
  }

  /** Stops recording and hands over what was found. */
  close(): readonly AutoResumeCandidate[] {
    this.open = false;
    return [...this.found];
  }
}
