/**
 * What an ended Codex ferret's runtime leaves behind, answered when Ferrets says the ferret stopped
 * (docs/design/account-model.md §8.4).
 *
 * Today two decorators on the session launcher and the reap did this, each knowing Codex. In the rebuild Ferrets is core
 * and never calls a plugin, so Runtimes listens instead: it subscribes to Ferrets' `ferrets.changed`, and when a ferret
 * has stopped it reads that ferret from `FerretsPort` and decides for itself.
 *
 * - **A Codex ferret that stopped** — whatever the cause — has its runtime's app-server pair stopped when nothing else
 *   uses that runtime ({@link CodexAppServerSupervisor.afterSessionEnded} owns that rule).
 * - **A Codex ferret whose launch failed** (`cause: start_failed`) is looked at once more: when the pane it died in
 *   showed the offline failure, the owner is told in words ({@link codexLaunchFailure}).
 * - **Anything else** — a Claude ferret, a ferret that has not stopped, one that ran no runtime, one Ferrets no longer
 *   knows — is not Runtimes' business and changes nothing.
 *
 * Housekeeping after an ending never fails the ending: nothing here throws.
 */
import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import { type CodexAppServerOutcome, codexLaunchFailure } from './codex-runtime.ts';

/** The host seams an ended ferret's follow-up stands on. Absent until the host offers them (see `RuntimesAssembly`). */
export interface RuntimeEndSeams {
  /** Stops the app-server pair a finished session's Codex runtime started, when nothing else uses it. */
  readonly supervisor: { afterSessionEnded(wrapper: string): Promise<CodexAppServerOutcome> };
  /** The published wrapper of a runtime by its name, or `undefined` when none is published under it. */
  wrapperOf(runtime: string): Promise<string | undefined>;
  /** What the dead pane of this ferret last showed, when the host can still say. */
  paneText?(ferret: string): Promise<string>;
}

/** What `ferrets.changed` says of one ferret. */
export interface FerretChange {
  readonly ferret: string;
  readonly state?: string;
  readonly gone?: true;
}

export interface RuntimeEndSupervisionDeps {
  readonly ferrets: Pick<FerretsApi, 'get'>;
  /** `undefined` while the host offers none: the subscriber stays attached and does nothing. */
  readonly seams: RuntimeEndSeams | undefined;
  /** The owner is to be told why a Codex ferret never started. */
  readonly launchFailed: (failure: {
    readonly ferret: string;
    readonly runtime: string;
    readonly message: string;
  }) => void;
}

export class RuntimeEndSupervision {
  constructor(private readonly deps: RuntimeEndSupervisionDeps) {}

  async onChanged(change: FerretChange): Promise<void> {
    const seams = this.deps.seams;
    // Only a reported stop is acted on: a missing state or a ferret that is gone proves nothing about its runtime.
    if (seams === undefined || change.state !== 'stopped') return;
    try {
      await this.#ended(seams, change.ferret);
    } catch {
      // Housekeeping; the ending already happened.
    }
  }

  async #ended(seams: RuntimeEndSeams, ferret: string): Promise<void> {
    const summary = await this.deps.ferrets.get(ferret as FerretId);
    if (summary?.state !== 'stopped' || summary.harness !== 'codex' || summary.runtime === undefined) return;
    const wrapper = await seams.wrapperOf(summary.runtime);
    if (wrapper !== undefined) await seams.supervisor.afterSessionEnded(wrapper);
    if (summary.cause?.kind !== 'start_failed' || seams.paneText === undefined) return;
    const message = codexLaunchFailure(await seams.paneText(ferret).catch(() => ''));
    if (message !== undefined) this.deps.launchFailed({ ferret, runtime: summary.runtime, message });
  }
}
