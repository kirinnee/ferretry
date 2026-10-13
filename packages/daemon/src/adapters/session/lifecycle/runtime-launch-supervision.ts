/**
 * What a session's runtime leaves behind, answered at the two places a session ends, and what a
 * runtime that could not start says about it (docs/design/account-model.md §8.4).
 *
 * Both are decorators, so neither the tmux launcher nor the reap knows anything about Codex:
 *
 * - {@link RuntimeSupervisedLauncher} wraps the lifecycle launcher. After a STOP it asks the Codex
 *   supervisor to stop the app-server daemon that session's runtime started; when READY or DELIVER
 *   fails it reads what the dead pane last showed and, for a Codex that could not reach the network
 *   while starting, replaces the error with one that says so.
 * - {@link RuntimeSupervisedReaper} wraps the reap, which ends a session whose pane outlived it, and
 *   does the same after each target it reaps.
 *
 * Housekeeping after an ending never fails the ending: the supervisor answers a value and never throws,
 * and a session id whose record cannot be read is simply not followed up.
 */
import { type CodexAppServerOutcome, codexLaunchFailure } from '../../../lib/fleet/codex-runtime.ts';
import type { SessionLifecycleLauncher, SessionLifecycleRecord } from '../../../lib/session/lifecycle/index.ts';
import type { ExactTerminalReaper } from '../../../lib/session/reap-service.ts';
import type { TerminalReapTarget } from '../../../lib/session/reap.ts';

/** The one thing either decorator asks of the Codex supervisor. */
export interface RuntimeEndedSupervisor {
  afterSessionEnded(wrapper: string): Promise<CodexAppServerOutcome>;
}

/** What a session's pane last showed. */
export interface PaneScreenReader {
  text(record: SessionLifecycleRecord): Promise<string>;
}

export class RuntimeSupervisedLauncher implements SessionLifecycleLauncher {
  constructor(
    private readonly inner: SessionLifecycleLauncher,
    private readonly supervisor: RuntimeEndedSupervisor,
    private readonly screen: PaneScreenReader,
  ) {}

  async alive(record: SessionLifecycleRecord): Promise<boolean> {
    return await this.inner.alive(record);
  }

  async launch(record: SessionLifecycleRecord): Promise<void> {
    await this.inner.launch(record);
  }

  async ready(record: SessionLifecycleRecord): Promise<void> {
    await this.inner.ready(record).catch(async (error: unknown) => {
      throw await this.#explained(record, error);
    });
  }

  async deliver(record: SessionLifecycleRecord, instruction: string, beforeWrite?: () => Promise<void>): Promise<void> {
    await this.inner.deliver(record, instruction, beforeWrite).catch(async (error: unknown) => {
      throw await this.#explained(record, error);
    });
  }

  async snapshot(record: SessionLifecycleRecord): Promise<void> {
    await this.inner.snapshot(record);
  }

  async stop(record: SessionLifecycleRecord): Promise<void> {
    await this.inner.stop(record);
    await this.supervisor.afterSessionEnded(record.config.agent);
  }

  /** The launch error a person can act on, when the pane says what went wrong; else the original. */
  async #explained(record: SessionLifecycleRecord, error: unknown): Promise<unknown> {
    const text = await this.screen.text(record).catch(() => '');
    const explained = codexLaunchFailure(text);
    return explained === undefined ? error : new Error(explained, { cause: error });
  }
}

export class RuntimeSupervisedReaper implements ExactTerminalReaper {
  constructor(
    private readonly inner: ExactTerminalReaper,
    private readonly supervisor: RuntimeEndedSupervisor,
    /** The launcher a reaped session ran, or `undefined` when its record cannot say. */
    private readonly agentOf: (sessionId: string) => Promise<string | undefined>,
  ) {}

  async reap(target: TerminalReapTarget): Promise<void> {
    await this.inner.reap(target);
    const agent = await this.agentOf(target.sessionId).catch(() => undefined);
    if (agent !== undefined) await this.supervisor.afterSessionEnded(agent);
  }
}
