import type { DaemonInspection } from '../daemon/controller.ts';
import type {
  IOnboardDaemon,
  IOnboardMachine,
  IOnboardOutput,
  IOnboardPairing,
  IOnboardPrompt,
  IOnboardRelay,
  RelayReach,
} from './ports.ts';
import {
  type DaemonAction,
  type PairingOffer,
  planDaemon,
  renderSetupSummary,
  renderSetupSummaryJson,
  summarize,
} from './summary.ts';

/** Flags `fy setup` accepts. */
export interface SetupOptions {
  /** Answer yes to installing the daemon, and ask nothing — required off a terminal. */
  readonly yes?: boolean;
  /** Print the summary as JSON instead of the human report. Implies no pairing QR. */
  readonly json?: boolean;
  /** Change nothing: report what is there and what setup would do. */
  readonly check?: boolean;
}

export interface OnboardDeps {
  /** The daemon verbs, built for this run; `quiet` sends their progress lines to stderr. */
  readonly daemon: (quiet: boolean) => IOnboardDaemon;
  readonly relay: IOnboardRelay;
  readonly machine: IOnboardMachine;
  readonly pairing: IOnboardPairing;
  readonly prompt: IOnboardPrompt;
  readonly out: IOnboardOutput;
  /** Whether a person is at this terminal, asked when a question would be. */
  readonly interactive: () => boolean;
  readonly clientName: string;
  readonly clientVersion: string;
}

/**
 * Drives `fy setup`: the one command after an install that leaves a machine ready to pair.
 *
 * IDEMPOTENT. It inspects first and only then acts — install the user service, or start the daemon
 * where there is no service manager, or nothing at all when the daemon already serves under its
 * manager. Running it twice is the same as running it once, so an agent can tell a person to run it
 * without first working out what state the machine is in.
 *
 * IT NEVER UPDATES. It reports an update and names the command, because an update restarts the daemon
 * and that is a separate decision (`fy daemon update`, or the app's Update button).
 *
 * THE PAIRING CODE NEVER LEAVES THE TERMINAL. The QR is offered only to a person at a terminal, after
 * the report; `--json`, `--yes` and a run with no terminal name `fy pair` as the next step instead.
 * That is what keeps a live credential out of anything a script or an agent keeps: the summary has no
 * field that could carry one.
 */
export class OnboardController {
  constructor(private readonly deps: OnboardDeps) {}

  async setup(options: SetupOptions): Promise<void> {
    const json = options.json === true;
    const check = options.check === true;
    const daemon = this.deps.daemon(json);
    const before = await daemon.inspect();
    const plan = planDaemon(before);

    let action: DaemonAction = 'none';
    let problem: string | undefined;
    if (plan === 'missing') action = 'failed';
    else if (plan !== 'none') {
      if (check) action = plan === 'install' ? 'would-install' : 'would-start';
      else if (options.yes !== true && !this.deps.interactive()) action = 'needs-terminal';
      else if (options.yes !== true && !(await this.#askYes(this.#question(plan)))) action = 'declined';
      else {
        try {
          await (plan === 'install' ? daemon.install() : daemon.start());
          action = plan === 'install' ? 'installed' : 'started';
        } catch (error: unknown) {
          action = 'failed';
          problem = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const after =
      action === 'installed' || action === 'started' || problem !== undefined
        ? await this.#reinspect(daemon, before)
        : before;
    const serving = after.view.reachability === 'serving';
    const relay: RelayReach = serving
      ? await this.deps.relay.reach()
      : { state: 'unknown', reason: 'the daemon is not running' };
    const setUp = serving ? await this.deps.machine.setUp() : undefined;
    const pairing: PairingOffer =
      serving && !json && !check && options.yes !== true && this.deps.interactive() ? 'now' : 'later';

    const summary = summarize({
      clientVersion: this.deps.clientVersion,
      clientName: this.deps.clientName,
      inspection: after,
      action,
      problem,
      relay,
      setUp,
      pairing,
    });
    if (json) this.deps.out.report(renderSetupSummaryJson(summary));
    else if (summary.ready) this.deps.out.success(renderSetupSummary(summary));
    else this.deps.out.warn(renderSetupSummary(summary));
    if (summary.exitCode !== 0) this.deps.out.setExitCode(summary.exitCode);

    if (pairing === 'now' && (await this.#askYes('Pair your phone now?'))) await this.deps.pairing.pair();
    else if (pairing === 'now') this.deps.out.report(`Pair later with \`${this.deps.clientName} pair\`.`);
  }

  #question(plan: 'install' | 'start'): string {
    return plan === 'install'
      ? 'Install the Ferretry daemon as a user service and start it?'
      : 'Start the Ferretry daemon?';
  }

  /** After a change, read again; a failed install can leave nothing readable, and the old facts stand. */
  async #reinspect(daemon: IOnboardDaemon, before: DaemonInspection): Promise<DaemonInspection> {
    try {
      return await daemon.inspect();
    } catch {
      return before;
    }
  }

  /** A yes/no a person answers, defaulting to yes. */
  async #askYes(question: string): Promise<boolean> {
    const answer = (await this.deps.prompt.ask(`${question} [Y/n]`)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  }
}
