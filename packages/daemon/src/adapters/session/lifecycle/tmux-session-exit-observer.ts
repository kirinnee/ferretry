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
  parsePaneIdentity,
  sessionTarget,
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
 * How many consecutive self-check ticks a dead pane may go without an exit status before the
 * session is settled as an exit nobody recorded.
 *
 * tmux marks a pane dead when its terminal closes and records the status only once it reaps the
 * child, which on a loaded host can be a long moment later. A tick landing between the two must not
 * settle the session, because "not recorded" is permanent and the number may be one tick away. So a
 * dead pane without a status is left `running` and looked at again, and the bound is counted in
 * TICKS rather than waited out inside one: a tick never sleeps, and the honest cost of the slow case
 * is a session that reads running for an extra interval or two.
 */
const EXIT_STATUS_MISSING_TICK_LIMIT = 3;

function status(state: JsonValue | undefined): string | undefined {
  const value = jsonObject(state)?.status;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The three facts that say how a pane ended. `pane_dead_signal` is why this is not the shared
 * metadata format: a program a signal killed has NO `pane_dead_status`, only a signal number.
 */
const PANE_EXIT_FORMAT = '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}';

/**
 * Asks the server to collect children whose SIGCHLD it lost.
 *
 * tmux resets SIGCHLD to its default for the moment it spends updating the login records of a pane
 * whose terminal just closed (libutempter), and a pane process that finishes exiting inside that
 * moment is left an unreaped zombie with no status — measured on a CI host with tmux 3.6a, where the
 * server was idle in `poll` with the zombie its only child. It is never collected on its own, because
 * tmux only reaps when a SIGCHLD reaches it. A background `run-shell` makes the server fork one
 * short job, and that job's SIGCHLD runs the server's reap loop, which waits for ANY child, so the lost
 * one is collected with it and the next tick reads its status. `-b` so the command returns at once:
 * a blocking one waits on that same SIGCHLD and would hang a tick if it were lost too. The job is
 * `true` under `/bin/sh` — no harness, no spend.
 */
const REAP_NUDGE = ['run-shell', '-b', 'true'] as const;

function paneNumber(field: string | undefined): number | undefined {
  if (field === undefined || !/^[0-9]+$/u.test(field)) return undefined;
  return Number(field);
}

/** A dead pane's identity for the missing-status count: a relaunched pane starts from zero. */
function paneKey(pane: RegisteredTerminalPane): string {
  return `${pane.sessionId}\n${pane.tmuxSession}\n${pane.paneId}\n${pane.pid}\n${pane.processStartTicks}`;
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
 * NOTHING IS KILLED AND NO HARNESS IS LAUNCHED. The observation is three read-only tmux queries per
 * running session, plus one `run-shell -b true` for a dead pane still missing its status, so tmux
 * collects a child whose SIGCHLD it lost (see `REAP_NUDGE`); the settle is one state write plus one
 * journal event.
 *
 * THE ONE PIECE OF STATE is how many consecutive ticks each dead pane has gone without an exit
 * status. It is memory only and keyed by the whole pane identity, so a restarted daemon simply
 * observes again from zero, and it is pruned to the panes seen on each tick.
 */
export class TmuxSessionExitObserver implements SessionExitPort {
  constructor(
    private readonly daemonId: string,
    private readonly storage: DaemonStorage,
    private readonly panes: DurableTerminalPaneStore,
    private readonly tmux: TmuxCommandPort,
    private readonly launches: SessionLaunchesInFlight,
    private readonly clock: ClockPort,
  ) {}

  /** Pane identity → consecutive ticks it has been dead with no exit status. */
  private readonly missingStatus = new Map<string, number>();

  async observe(): Promise<readonly SessionExitObservation[]> {
    if (this.daemonId.length === 0) return [];
    // The tolerant scan: one hand-edited registration must not hide every other exited session.
    const { registrations } = await this.panes.scan(this.daemonId);
    const observed: SessionExitObservation[] = [];
    const stillMissing = new Set<string>();
    for (const registration of registrations) {
      const id = parseSessionId(registration.sessionId);
      if (this.launches.launching(id)) continue;
      const current = status(await this.storage.readState(id));
      if (current === undefined || !claimsRunningAgent(current)) continue;
      const exit = await this.exitOf(registration).catch(() => undefined);
      if (exit === undefined) continue;
      const unrecorded = exit.kind === 'exited' && exit.exitStatus === undefined && exit.signal === undefined;
      if (unrecorded && !this.missedEnough(registration, stillMissing)) continue;
      observed.push({ id, status: current, registration, exit });
    }
    for (const key of this.missingStatus.keys()) if (!stillMissing.has(key)) this.missingStatus.delete(key);
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

  /** Counts one more statusless tick for a dead pane; true once the bound says to settle anyway. */
  private missedEnough(registration: RegisteredTerminalPane, stillMissing: Set<string>): boolean {
    const key = paneKey(registration);
    const misses = (this.missingStatus.get(key) ?? 0) + 1;
    if (misses >= EXIT_STATUS_MISSING_TICK_LIMIT) return true;
    this.missingStatus.set(key, misses);
    stillMissing.add(key);
    return false;
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
    const exitResult = await this.tmux.execute([
      'display-message',
      '-p',
      '-t',
      sessionTarget(registration.tmuxSession),
      PANE_EXIT_FORMAT,
    ]);
    if (exitResult.code !== 0) return undefined;
    const [dead, exitStatusField, signalField] = exitResult.stdout.trimEnd().split('|');
    if (dead !== '1') return undefined;
    const exitStatus = paneNumber(exitStatusField);
    const signal = paneNumber(signalField);
    // Best effort: a refused nudge changes nothing, and the missing-status bound still settles.
    if (exitStatus === undefined && signal === undefined) await this.tmux.execute(REAP_NUDGE).catch(() => undefined);
    return { kind: 'exited', exitStatus, signal };
  }
}
