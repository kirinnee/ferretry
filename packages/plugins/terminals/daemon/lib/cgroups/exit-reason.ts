/**
 * "Killed for memory" as the end reason of a ferret the kernel stopped.
 *
 * WHEN THE AGENT ITSELF DIES OF AN OOM KILL, the pane only shows a SIGKILL (signal 9, or status 137 from a
 * wrapping shell) — and the self-check would record "the agent was ended by signal 9", which reads like a
 * crash nobody can explain. The memory watcher saw the kernel's counter rise for that ferret's scope, so
 * when the two agree the reason says what happened, in words.
 *
 * It only RE-WORDS a settle that is happening anyway. It never settles, never decides a session is over,
 * and ignores an exit that was not a kill signal, so a ferret that merely finished near a memory event is
 * not mislabelled.
 */
import type { ExitedSessionTransition, SessionExitObservation } from '../session/health/exit.ts';
import type { SessionExitPort } from '../session/health/service.ts';
import type { ExitObserveOptions, SurveyedSession } from '../session/health/types.ts';

/** How long after a kernel kill an exit by SIGKILL is still put down to it. */
export const MEMORY_KILL_WINDOW_MS = 10 * 60_000;

/** Something that remembers recent kills for memory. */
export interface RecentMemoryKills {
  killedRecently(sessionId: string, withinMs: number): { readonly what?: string; readonly bytes?: number } | undefined;
}

const SIGKILL = 9;
const KILLED_STATUS = 137;

/** The exit was the kernel's kill, not anything the agent chose. */
export function exitedByKillSignal(observation: SessionExitObservation): boolean {
  return (
    observation.exit.kind === 'exited' &&
    (observation.exit.signal === SIGKILL || observation.exit.exitStatus === KILLED_STATUS)
  );
}

export function killedForMemoryReason(kill: { readonly what?: string; readonly bytes?: number }): string {
  const detail = kill.what === undefined ? '' : ` while ${kill.what} was using the memory`;
  return `the agent was killed for memory: it passed its memory limit${detail}`;
}

export class MemoryKillExitPort implements SessionExitPort {
  constructor(
    private readonly inner: SessionExitPort,
    private readonly kills: RecentMemoryKills,
    private readonly windowMs: number = MEMORY_KILL_WINDOW_MS,
  ) {}

  observe(
    survey: readonly SurveyedSession[],
    options?: ExitObserveOptions,
  ): Promise<readonly SessionExitObservation[]> {
    return this.inner.observe(survey, options);
  }

  async settle(observation: SessionExitObservation, transition: ExitedSessionTransition): Promise<boolean> {
    const kill = exitedByKillSignal(observation) ? this.kills.killedRecently(observation.id, this.windowMs) : undefined;
    return await this.inner.settle(
      observation,
      kill === undefined ? transition : { ...transition, reason: killedForMemoryReason(kill) },
    );
  }
}
