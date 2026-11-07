import {
  compareProtocolVersions,
  HARNESS_CLI_LABELS,
  type Harness,
  type HarnessCliView,
  harnessUpdatePlan,
  installedHarnessVersion,
  knownLatestRelease,
  needsUnverifiedConsent,
  ProtocolVersionSchema,
} from '@ferretry/protocol';
import type { HarnessWait, IHarnessOutput, IHarnessPrompt, IHarnessUpdateGateway } from './ports.ts';
import { renderHarnessStatus } from './render.ts';

/** How often `fy harness update` reads the view while the daemon runs the update. */
export const HARNESS_UPDATE_POLL_MS = 2_000;

export interface HarnessStatusOptions {
  readonly json?: boolean;
}

export interface HarnessUpdateOptions {
  /** A version, or `verified` for the version Ferretry verified. */
  readonly to?: string;
  readonly yes?: boolean;
  /** The explicit yes to going past the version Ferretry verified; `--yes` alone never gives it. */
  readonly allowUnverified?: boolean;
}

export interface HarnessControllerDeps {
  readonly gateway: IHarnessUpdateGateway;
  readonly out: IHarnessOutput;
  readonly prompt: IHarnessPrompt;
  readonly interactive: boolean;
  readonly wait: HarnessWait;
  readonly binaryName: string;
}

const HARNESSES: readonly Harness[] = ['claude', 'codex'];

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * `fy harness status` and `fy harness update`: the same daemon view and the same update the app's
 * Settings › Agent CLIs uses, so a terminal and a phone can never disagree about a machine.
 */
export class HarnessController {
  constructor(private readonly deps: HarnessControllerDeps) {}

  async status(options: HarnessStatusOptions): Promise<void> {
    const view = await this.deps.gateway.harnessUpdate();
    this.deps.out.report(
      options.json === true ? JSON.stringify(view, null, 2) : renderHarnessStatus(view, this.deps.binaryName),
    );
  }

  async update(harness: string | undefined, options: HarnessUpdateOptions): Promise<void> {
    if (harness !== undefined && !HARNESSES.includes(harness as Harness))
      throw new Error(`unknown harness "${harness}"; name claude or codex`);
    const to = options.to;
    if (to !== undefined && to !== 'verified' && !ProtocolVersionSchema.safeParse(to).success)
      throw new Error(`--to takes a version like 2.1.220, or "verified"; got "${to}"`);
    const view = await this.deps.gateway.harnessUpdate();
    const wanted = harness === undefined ? HARNESSES : [harness as Harness];
    for (const name of wanted) {
      const entry = view.harnesses.find(candidate => candidate.harness === name);
      if (entry !== undefined) await this.#updateOne(entry, options);
    }
  }

  async #updateOne(view: HarnessCliView, options: HarnessUpdateOptions): Promise<void> {
    const { out } = this.deps;
    const label = HARNESS_CLI_LABELS[view.harness];
    if (view.method === null || view.plan === null) {
      out.error(`${label}: this daemon cannot find it, so there is nothing to update.`);
      out.setExitCode(1);
      return;
    }
    const target = options.to === 'verified' ? view.verified.version : options.to;
    const plan = harnessUpdatePlan(view.harness, view.method, target);
    if (plan.kind === 'manual') {
      out.warn(`${label}: ${plan.explanation}`);
      for (const step of plan.steps)
        out.report(`  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`);
      out.setExitCode(1);
      return;
    }
    const installed = installedHarnessVersion(view);
    const goal = target ?? knownLatestRelease(view.check)?.version;
    if (installed !== undefined && goal !== undefined && compareProtocolVersions(goal, installed) !== 1) {
      out.success(
        `${label} ${installed} is already ${target === undefined ? 'the newest version known' : `at or past ${target}`}.`,
      );
      return;
    }
    out.report(
      `${label} ${installed ?? '(version unreadable)'} → ${goal ?? 'the newest available'}, with: ${plan.steps.map(step => step.command).join(', then ')}`,
    );
    const unverified = goal === undefined || needsUnverifiedConsent(view.harness, goal);
    if (unverified && !(await this.#allowUnverified(view, goal, options))) return;
    if (!(await this.#confirm('Update now?', options.yes))) return;
    try {
      await this.deps.gateway.startHarnessUpdate({
        harness: view.harness,
        ...(target === undefined ? {} : { target }),
        ...(unverified ? { confirmUnverified: true } : {}),
      });
    } catch (error) {
      out.error(`${label}: ${messageOf(error)}`);
      out.setExitCode(1);
      return;
    }
    out.report(`Updating ${label}… this can take a few minutes.`);
    await this.#awaitReport(view.harness);
  }

  async #allowUnverified(
    view: HarnessCliView,
    goal: string | undefined,
    options: HarnessUpdateOptions,
  ): Promise<boolean> {
    const { out } = this.deps;
    const label = HARNESS_CLI_LABELS[view.harness];
    out.warn(
      goal === undefined
        ? `Ferretry could not learn which ${label} version this installs, so it may be one Ferretry has not verified (verified: ${view.verified.version}). ${view.verified.url}`
        : `${label} ${goal} has not been verified by Ferretry yet (verified: ${view.verified.version}). Known risks: ${view.verified.url}`,
    );
    if (options.allowUnverified === true) return true;
    if (!this.deps.interactive) {
      out.error(`Nothing was changed. Re-run with --allow-unverified to install it anyway, or --to verified.`);
      out.setExitCode(1);
      return false;
    }
    return await this.#confirm('Install a version Ferretry has not verified?', false);
  }

  async #confirm(question: string, yes: boolean | undefined): Promise<boolean> {
    const { out } = this.deps;
    if (yes === true) return true;
    if (!this.deps.interactive) {
      out.error('Nothing was changed: this needs a yes. Re-run with --yes to go ahead without being asked.');
      out.setExitCode(1);
      return false;
    }
    const answer = (await this.deps.prompt.ask(`${question} [y/N]`)).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') return true;
    out.warn('Nothing was changed.');
    out.setExitCode(1);
    return false;
  }

  async #awaitReport(harness: Harness): Promise<void> {
    const { out } = this.deps;
    for (;;) {
      await this.deps.wait(HARNESS_UPDATE_POLL_MS);
      const entry = (await this.deps.gateway.harnessUpdate()).harnesses.find(
        candidate => candidate.harness === harness,
      );
      const job = entry?.job;
      if (job?.state !== 'finished') continue;
      const { outcome, message } = job.report;
      if (outcome === 'succeeded' || outcome === 'unchanged') out.success(message);
      else {
        if (outcome === 'rolled-back') out.warn(message);
        else out.error(message);
        out.setExitCode(1);
      }
      return;
    }
  }
}
