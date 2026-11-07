/** The daemon cached update view, printed by the plugin read verb. */
import {
  type DaemonUpdateView,
  DaemonUpdateViewSchema,
  describeInstallMethod,
  knownLatestRelease,
} from '../../contract/index.ts';

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
