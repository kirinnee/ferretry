import type { SessionView } from '@ferretry/protocol';
import { buildStopPlan, StopSelectorError } from './plan.ts';
import { confirmationPhrase, defaultStopReason, renderStopPlan, renderStopSweep } from './render.ts';
import type {
  BulkStopOptions,
  BulkStopResult,
  BulkStopSelector,
  IBulkStopRunner,
  IStopIo,
  IStopPrompt,
  IStopSessionGateway,
  StopOutcome,
  StopPlan,
  StopSweepResult,
} from './types.ts';

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Commander stores an option written before a subcommand on the parent command. Preserve that
 * explicit reason while still letting a reason written on the named mode itself win.
 */
export function inheritStopReason(options: BulkStopOptions, parentReason?: string): BulkStopOptions {
  if (options.reason !== undefined || parentReason === undefined) return options;
  return { ...options, reason: parentReason };
}

/** Environment facts the controller is told rather than reads — nothing here touches `process`. */
export interface BulkStopContext {
  /** Whether a human can actually answer the confirmation prompt. */
  readonly interactive: boolean;
  /** The session issuing the command, when the CLI is running inside one. */
  readonly callerId?: string;
  /** The shipped binary name, used only to phrase the default stop reason. */
  readonly binaryName: string;
}

function withResolvedRoot(sessions: readonly SessionView[], root: SessionView | undefined): SessionView[] {
  if (!root || sessions.some(view => view.config.id.trim() === root.config.id.trim())) return [...sessions];
  return [...sessions, root];
}

/** One controller for the whole `stop <mode>` command group: plan, confirm, sweep, race-check. */
export class BulkStopController implements IBulkStopRunner {
  constructor(
    private readonly gateway: IStopSessionGateway,
    private readonly io: IStopIo,
    private readonly prompt: IStopPrompt,
    private readonly context: BulkStopContext,
  ) {}

  async run(selector: BulkStopSelector, options: BulkStopOptions): Promise<BulkStopResult> {
    let plan: StopPlan;
    let resolved: BulkStopSelector;
    try {
      const resolution = await this.#resolveSelector(selector);
      resolved = resolution.selector;
      plan = buildStopPlan(withResolvedRoot(await this.gateway.list(), resolution.root), resolved, {
        ...(this.context.callerId ? { callerId: this.context.callerId } : {}),
        ...(options.includeCaller === undefined ? {} : { includeCaller: options.includeCaller }),
      });
    } catch (error) {
      return this.#fail(errorText(error));
    }

    this.io.success(renderStopPlan(plan));

    if (options.dryRun) {
      this.io.success('Dry run: no sessions were stopped.');
      return { exitCode: 0, plan, confirmed: false };
    }
    if (!plan.targets.length) {
      this.io.success('Nothing eligible to stop.');
      return { exitCode: 0, plan, confirmed: false };
    }
    if (!options.yes && !(await this.#confirm(plan))) return { exitCode: 1, plan, confirmed: false };

    const reason = options.reason?.trim() || defaultStopReason(resolved, this.context.binaryName);
    const sweep = await this.#sweep(plan, reason, options.includeCaller);
    this.io.success(renderStopSweep(sweep));

    const failed = sweep.outcomes.some(outcome => !outcome.ok) || sweep.appeared.length > 0 || !!sweep.raceCheckError;
    if (failed) this.io.setExitCode(1);
    return { exitCode: failed ? 1 : 0, plan, sweep, confirmed: true };
  }

  /**
   * Lineage selectors resolve their root through the daemon so that a CLI alias or short id names
   * exactly the session a single `stop` would have hit.
   */
  async #resolveSelector(selector: BulkStopSelector): Promise<{ selector: BulkStopSelector; root?: SessionView }> {
    if (selector.kind === 'label') {
      const label = selector.label.trim();
      if (!label) throw new StopSelectorError('label must not be empty');
      return { selector: { kind: 'label', label } };
    }
    if (!selector.rootId.trim()) throw new StopSelectorError('session id must not be empty');
    const root = await this.gateway.get(selector.rootId);
    return { selector: { ...selector, rootId: root.config.id.trim() }, root };
  }

  async #confirm(plan: StopPlan): Promise<boolean> {
    if (!this.context.interactive) {
      this.io.error(
        'Refusing an unconfirmed bulk stop on non-interactive input; review the list and re-run with --yes.',
      );
      this.io.setExitCode(1);
      return false;
    }
    const phrase = confirmationPhrase(plan);
    const answer = await this.prompt.ask(`Type ${JSON.stringify(phrase)} to confirm:`);
    if (answer.trim() === phrase) return true;
    this.io.error('Confirmation did not match; no sessions were stopped.');
    this.io.setExitCode(1);
    return false;
  }

  /** Execute only the already-confirmed ids, then detect — never auto-kill — anything new. */
  async #sweep(plan: StopPlan, reason: string, includeCaller?: boolean): Promise<StopSweepResult> {
    const outcomes: StopOutcome[] = [];
    for (const target of plan.targets) {
      try {
        const stopped = await this.gateway.stop(target.id, reason);
        outcomes.push({ target, ok: true, status: stopped.state.status });
      } catch (error) {
        outcomes.push({ target, ok: false, error: errorText(error) });
      }
    }

    try {
      const rescanned = buildStopPlan(await this.gateway.list(), plan.selector, {
        ...(plan.callerId ? { callerId: plan.callerId } : {}),
        ...(includeCaller === undefined ? {} : { includeCaller }),
      });
      const confirmedIds = new Set(plan.candidates.map(target => target.id));
      const knownLeftRunning = new Set(plan.leftRunning.map(target => target.id));
      return {
        kind: plan.selector.kind,
        outcomes,
        appeared: rescanned.candidates.filter(target => !confirmedIds.has(target.id)),
        leftRunning: rescanned.leftRunning,
        appearedLeftRunning: rescanned.leftRunning.filter(target => !knownLeftRunning.has(target.id)),
      };
    } catch (error) {
      return {
        kind: plan.selector.kind,
        outcomes,
        appeared: [],
        leftRunning: [],
        appearedLeftRunning: [],
        raceCheckError: errorText(error),
      };
    }
  }

  #fail(message: string): BulkStopResult {
    this.io.error(message);
    this.io.setExitCode(1);
    return { exitCode: 1, confirmed: false };
  }
}
