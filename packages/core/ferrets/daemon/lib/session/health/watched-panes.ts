import type { ExitedSessionTransition, SessionExitObservation } from './exit.ts';
import type { SessionExitPort } from './service.ts';
import type { ExitObserveOptions, SurveyedSession } from './types.ts';

/**
 * WHICH RUNNING SESSIONS' PANES A SESSION WORKER VOUCHES FOR, so the self-check need not ask tmux about
 * them (stage 3d of `docs/design/session-workers.md`).
 *
 * A session's worker is subscribed to its pane's `#{pane_dead}` through its own attached client and says
 * `exited` the moment it turns 1 — or once its client has been down long enough that it can no longer
 * say the pane is alive. Until then the pane is watched, and the 30 s exit pass skips it: three tmux
 * queries per running session every tick were the only thing it did for one.
 *
 * A pane is unwatched again — and the self-check proves it as it always has — once its worker said
 * `exited`, for as long as that session stays hosted, and whenever no worker hosts it. The hosting is
 * late-bound: the supervisor is composed after the self-check that reads this.
 */
export class WatchedPanes {
  private hosts: (id: string) => boolean = () => false;
  private readonly unwatched = new Set<string>();

  /** Who answers whether a worker hosts a session. */
  hostedBy(hosts: (id: string) => boolean): void {
    this.hosts = hosts;
  }

  /** A session's worker no longer vouches for its pane. */
  exited(id: string): void {
    this.unwatched.add(id);
  }

  watched(id: string): boolean {
    if (!this.hosts(id)) {
      this.unwatched.delete(id);
      return false;
    }
    return !this.unwatched.has(id);
  }
}

/** The exit pass over the sessions no worker watches: a watched pane cannot be proven dead anyway. */
export class UnwatchedPaneExits implements SessionExitPort {
  constructor(
    private readonly exits: SessionExitPort,
    private readonly panes: Pick<WatchedPanes, 'watched'>,
  ) {}

  async observe(
    survey: readonly SurveyedSession[],
    options?: ExitObserveOptions,
  ): Promise<readonly SessionExitObservation[]> {
    return await this.exits.observe(
      survey.filter(session => !this.panes.watched(session.id)),
      options,
    );
  }

  async settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean> {
    return await this.exits.settle(observation, transition);
  }
}
