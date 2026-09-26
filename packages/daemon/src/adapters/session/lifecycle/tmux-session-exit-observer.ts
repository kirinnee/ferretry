import { type JsonValue, jsonObject } from '../../../lib/json.ts';
import type { ClockPort } from '../../../lib/ports.ts';
import {
  claimsRunningAgent,
  type ExitedSessionTransition,
  type SessionExitObservation,
  type SessionPaneExit,
} from '../../../lib/session/health/exit.ts';
import type { SessionExitPort } from '../../../lib/session/health/service.ts';
import type { RegisteredTerminalPane } from '../../../lib/session/reap.ts';
import { parseSessionId, type SessionId } from '../../../lib/session-id.ts';
import {
  hasSessionArguments,
  paneIdentityArguments,
  paneMetadataArguments,
  parsePaneIdentity,
  parsePaneMetadata,
  type TmuxCommandPort,
} from '../../../lib/tmux/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';
import type { DurableTerminalPaneStore } from './durable-terminal-pane-reap.ts';

/** Which sessions have a launch in flight right now; the resume gate's own read. */
export interface SessionLaunchesInFlight {
  launching(id: SessionId): boolean;
}

/**
 * The refusals by which tmux says a session is not there at all — as opposed to a command that
 * failed for some other reason, which proves nothing. The server-down pair is the whole private
 * server being gone, which takes every pane it held with it.
 */
const ABSENT_SESSION = /can't find session|no server running|error connecting to/iu;

/**
 * How long a dead pane is given to report its exit status.
 *
 * tmux marks a pane dead when its terminal closes, and records the status only once it reaps the
 * child, a moment later. A tick landing between the two would otherwise settle the session as an
 * exit nobody recorded, permanently, when the number was milliseconds away. A tmux that never
 * reports one still settles, after the budget.
 */
const EXIT_STATUS_ATTEMPTS = 10;
const EXIT_STATUS_POLL_MS = 50;

function status(state: JsonValue | undefined): string | undefined {
  const value = jsonObject(state)?.status;
  return typeof value === 'string' ? value : undefined;
}

function samePane(left: RegisteredTerminalPane, right: RegisteredTerminalPane): boolean {
  return (
    left.tmuxSession === right.tmuxSession &&
    left.paneId === right.paneId &&
    left.pid === right.pid &&
    left.processStartTicks === right.processStartTicks
  );
}

/**
 * Proves a registered pane dead or gone from the daemon's private tmux server, and records it.
 *
 * ONLY REGISTERED PANES ARE EVER ASKED ABOUT, exactly as the reap does: the candidates come from the
 * durable registrations, never from a tmux listing, so a human's own shell cannot become one.
 *
 * A DEAD PANE MUST BE THE REGISTERED PANE. Every launch sets `remain-on-exit`, so an agent that ends
 * leaves its pane behind marked dead, still carrying its id and the pid it ran. Both must equal the
 * registration or the observation says nothing — a pane id tmux handed to a newer pane is not ours.
 * The process-start incarnation is deliberately NOT consulted: it is how a LIVE pid is told apart
 * from a reused one, and a dead pane has no live process to ask; tmux's own `pane_dead` is the proof.
 *
 * NOTHING IS KILLED AND NOTHING IS LAUNCHED. The observation is two read-only tmux queries per
 * running session and the settle is one state write plus one journal event.
 */
export class TmuxSessionExitObserver implements SessionExitPort {
  constructor(
    private readonly daemonId: string,
    private readonly storage: DaemonStorage,
    private readonly panes: DurableTerminalPaneStore,
    private readonly tmux: TmuxCommandPort,
    private readonly launches: SessionLaunchesInFlight,
    private readonly clock: ClockPort,
    private readonly sleep: (milliseconds: number) => Promise<void> = milliseconds => Bun.sleep(milliseconds),
  ) {}

  async observe(): Promise<readonly SessionExitObservation[]> {
    if (this.daemonId.length === 0) return [];
    // The tolerant scan: one hand-edited registration must not hide every other exited session.
    const { registrations } = await this.panes.scan(this.daemonId);
    const observed: SessionExitObservation[] = [];
    for (const registration of registrations) {
      const id = parseSessionId(registration.sessionId);
      if (this.launches.launching(id)) continue;
      const current = status(await this.storage.readState(id));
      if (current === undefined || !claimsRunningAgent(current)) continue;
      const exit = await this.exitOf(registration).catch(() => undefined);
      if (exit !== undefined) observed.push({ id, status: current, registration, exit });
    }
    return observed;
  }

  async settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean> {
    const id = parseSessionId(observation.id);
    if (this.launches.launching(id)) return false;
    const finishedAt = this.clock.now();
    let applied = false;
    await this.storage.updateState(id, async current => {
      applied = false;
      // Compare-and-set under the state lock: the status it was observed with AND the pane it was
      // observed in. A resume re-registers before it reports running, so a relaunched session fails
      // the second check even when its status reads the same as before.
      if (status(current) !== observation.status) return current;
      const registration = await this.panes.registration(this.daemonId, id);
      if (registration === undefined || !samePane(registration, observation.registration)) return current;
      applied = true;
      return {
        ...(jsonObject(current) ?? {}),
        status: transition.status,
        health: transition.health,
        reason: transition.reason,
        finishedAt,
        promptReady: false,
        ...(transition.exitCode === undefined ? {} : { exitCode: transition.exitCode }),
      };
    });
    if (!applied) return false;
    // After the state is durable, so the event never describes a transition that was not written.
    await this.storage.append(id, 'session.exited', {
      reason: transition.reason,
      from: observation.status,
      status: transition.status,
      pane: observation.exit.kind,
      exitCode: transition.exitCode ?? null,
    });
    return true;
  }

  /** How the registered pane ended, or `undefined` when it is live or nothing could be proven. */
  private async exitOf(registration: RegisteredTerminalPane): Promise<SessionPaneExit | undefined> {
    const present = await this.tmux.execute(hasSessionArguments(registration.tmuxSession));
    if (present.code !== 0) return ABSENT_SESSION.test(present.stderr) ? { kind: 'gone' } : undefined;
    const identityResult = await this.tmux.execute(paneIdentityArguments(registration.tmuxSession));
    if (identityResult.code !== 0) return undefined;
    const identity = parsePaneIdentity(identityResult.stdout);
    if (identity === undefined || identity.paneId !== registration.paneId || identity.pid !== registration.pid)
      return undefined;
    for (let attempt = 1; ; attempt += 1) {
      const metadataResult = await this.tmux.execute(paneMetadataArguments(registration.tmuxSession));
      if (metadataResult.code !== 0) return undefined;
      const metadata = parsePaneMetadata(metadataResult.stdout);
      if (!metadata.dead) return undefined;
      if (metadata.exitCode !== undefined || attempt >= EXIT_STATUS_ATTEMPTS)
        return { kind: 'exited', exitStatus: metadata.exitCode };
      await this.sleep(EXIT_STATUS_POLL_MS);
    }
  }
}
