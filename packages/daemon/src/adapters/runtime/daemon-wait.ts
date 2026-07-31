import {
  beginReadinessWait,
  decideReadiness,
  defaultReadinessPolicy,
  type PidLiveness,
  type ReadinessPolicy,
} from '../../lib/runtime/readiness.ts';
import type { ClockPort, SleepPort } from './daemon-boot.ts';

export interface DaemonReadinessPorts extends ClockPort, SleepPort {
  health(): Promise<Record<string, unknown>>;
  pidLiveness(): Promise<PidLiveness>;
  progress?(elapsedSeconds: number): void;
}

export class DaemonExitedError extends Error {}
export class DaemonNotReadyError extends Error {}

/** IO coordinator that waits for an injected daemon health endpoint to become ready. */
export class DaemonReadinessWaiter {
  constructor(
    private readonly ports: DaemonReadinessPorts,
    private readonly daemonLog: string,
    private readonly policy: ReadinessPolicy = defaultReadinessPolicy(),
  ) {}

  async wait(): Promise<Record<string, unknown>> {
    let state = beginReadinessWait(this.ports.now());
    while (true) {
      try {
        return await this.ports.health();
      } catch {
        const liveness = await this.ports.pidLiveness().catch<PidLiveness>(() => 'absent');
        const decision = decideReadiness(state, liveness, this.ports.now(), this.policy);
        if (decision.kind === 'exited')
          throw new DaemonExitedError(`fyd started but its process exited during startup; inspect ${this.daemonLog}`);
        if (decision.kind === 'timeout')
          throw new DaemonNotReadyError(
            `fyd did not become ready within ${Math.round(this.policy.deadlineMs / 1_000)}s; inspect ${this.daemonLog}`,
          );
        state = decision.state;
        if (decision.kind === 'progress') this.ports.progress?.(decision.elapsedSeconds);
        await this.ports.sleep(this.policy.cadenceMs);
      }
    }
  }
}
