/**
 * `fy update` (§1.4): asks the daemon how it was installed and whether a newer release exists, and — with your yes —
 * has the daemon start the update. The update itself is the transaction in `./updater.ts`, which runs beside the
 * daemon (it restarts it) and writes the report the new daemon reads (docs/updating.md).
 */
import {
  type DaemonUpdateStartRequest,
  type DaemonUpdateView,
  DaemonUpdateViewSchema,
  describeInstallMethod,
  knownLatestRelease,
} from '../../contract/index.ts';

const OK = 0;
const FAILED = 1;

/** The calls the verb makes: the daemon's update routes, the terminal, and (optionally) waiting and asking. */
export interface UpdateVerbDeps {
  view(): Promise<DaemonUpdateView>;
  start(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView>;
  out(line: string): void;
  err(line: string): void;
  /** Absent: the verb returns after the daemon accepted the update, and the app or `fy update --check` shows the rest. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Absent: a yes must be given as `--yes`. */
  confirm?: (question: string) => Promise<boolean>;
}

export interface UpdateVerbOptions {
  readonly check: boolean;
  readonly yes: boolean;
  readonly whenIdle: boolean;
  readonly to: string | undefined;
  readonly json: boolean;
}

const POLL_MS = 2_000;
/** About as long as the daemon waits for an update to report back (15 minutes). */
const MAX_POLLS = 450;

export function parseView(raw: unknown): DaemonUpdateView {
  return DaemonUpdateViewSchema.parse(raw);
}

/** The human lines for a view: how it was installed, whether it is behind, and what updating takes. */
export function viewLines(view: DaemonUpdateView): string[] {
  const lines = [`daemon    ${view.current}`, `installed ${describeInstallMethod(view.method)}`];
  const latest = knownLatestRelease(view.check);
  if (view.check.state === 'never') lines.push('latest    not checked yet');
  else if (view.check.state === 'failed')
    lines.push(
      `latest    ${latest === undefined ? 'unknown' : latest.version} (the last check failed: ${view.check.reason})`,
    );
  else lines.push(`latest    ${view.check.latest.version}`);
  if (view.available && latest !== undefined)
    lines.push(`behind    ${view.current} → ${latest.version} (${latest.url})`);
  if (view.plan.kind !== 'self') {
    lines.push('', 'explanation:', `  ${view.plan.explanation}`);
    if (view.plan.steps.length > 0) {
      lines.push('steps:');
      for (const step of view.plan.steps)
        lines.push(`  ${step.command}${step.note === undefined ? '' : `   # ${step.note}`}`);
    }
  }
  if (view.job?.state === 'waiting-for-idle')
    lines.push(
      `waiting   to update to ${view.job.target} once no ferret is mid-turn (${String(view.job.midTurn)} now)`,
    );
  if (view.job?.state === 'running') lines.push(`running   updating to ${view.job.target}`);
  if (view.job?.state === 'finished') lines.push(`last      ${view.job.report.outcome}: ${view.job.report.message}`);
  return lines;
}

export async function runUpdateVerb(deps: UpdateVerbDeps, options: UpdateVerbOptions): Promise<number> {
  const show = (view: DaemonUpdateView): void => {
    if (options.json) deps.out(JSON.stringify(view));
    else for (const line of viewLines(view)) deps.out(line);
  };
  let view = await deps.view();
  const latest = knownLatestRelease(view.check);
  if (options.check || !view.available || latest === undefined || view.plan.kind !== 'self') {
    show(view);
    return OK;
  }
  const target = options.to ?? latest.version;
  if (!options.yes) {
    const question = `update ${view.current} → ${target}?`;
    const agreed = deps.confirm === undefined ? false : await deps.confirm(question);
    if (!agreed) {
      show(view);
      deps.err(deps.confirm === undefined ? 'nothing changed; run it again with --yes to update' : 'nothing changed');
      return FAILED;
    }
  }
  view = await deps.start({ target, when: options.whenIdle ? 'when-idle' : 'now' });
  if (options.json || deps.sleep === undefined) {
    show(view);
    return OK;
  }
  deps.out(options.whenIdle ? `waiting to update to ${target}` : `updating to ${target}`);
  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    await deps.sleep(POLL_MS);
    let next: DaemonUpdateView;
    try {
      next = await deps.view();
    } catch {
      // The daemon restarts in the middle of an update; the new one answers in a moment.
      continue;
    }
    if (next.job?.state === 'finished' && next.job.report.target === target) {
      const { report } = next.job;
      (report.outcome === 'succeeded' ? deps.out : deps.err)(report.message);
      return report.outcome === 'succeeded' ? OK : FAILED;
    }
  }
  deps.err('the update has not reported back yet; `fy update --check` shows where it is');
  return FAILED;
}
