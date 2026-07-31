import {
  beginReadinessWait,
  decideReadiness,
  defaultReadinessPolicy,
  type DaemonReadinessPorts,
  type ReadinessPolicy,
} from '../../lib/runtime/readiness.ts';

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
      const remainingMs = Math.max(0, this.policy.deadlineMs - (this.ports.now() - state.startedAtMs));
      const outcome = await Promise.race([
        this.ports.health().then(
          value => ({ kind: 'healthy' as const, value }),
          () => ({ kind: 'unhealthy' as const }),
        ),
        new Promise<{ readonly kind: 'deadline' }>(resolve => {
          setTimeout(() => resolve({ kind: 'deadline' }), remainingMs);
        }),
      ]);
      if (outcome.kind === 'healthy') return outcome.value;
      if (outcome.kind === 'deadline') throw new DaemonNotReadyError(this.timeoutMessage());

      const liveness = await this.ports.pidLiveness().catch(() => 'absent' as const);
      const decision = decideReadiness(state, liveness, this.ports.now(), this.policy);
      if (decision.kind === 'exited')
        throw new DaemonExitedError(`fyd started but its process exited during startup; inspect ${this.daemonLog}`);
      if (decision.kind === 'timeout') throw new DaemonNotReadyError(this.timeoutMessage());
      state = decision.state;
      if (decision.kind === 'progress') this.ports.progress?.(decision.elapsedSeconds);
      await this.ports.sleep(this.policy.cadenceMs);
    }
  }

  private timeoutMessage(): string {
    return `fyd did not become ready within ${Math.round(this.policy.deadlineMs / 1_000)}s; inspect ${this.daemonLog}`;
  }
}
