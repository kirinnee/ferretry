import type { ScratchPlanView, ScratchSweepView } from '@ferretry/protocol';

/** Compact byte counts matching the established kteam command surface. */
function humanBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(0)} kB`;
}

/** A dry-run inventory, including why every retained session is ineligible. */
export function renderScratchPlan(plan: readonly ScratchPlanView[]): string {
  const lines: string[] = [];
  const eligible = plan.filter(item => item.eligible);
  const total = eligible.reduce((sum, item) => sum + item.bytes, 0);

  for (const item of plan) {
    const mark = item.eligible ? 'FREE' : 'keep';
    lines.push(
      `${mark}  ${item.sessionId}  ${humanBytes(item.bytes).padStart(8)}  ${item.teammate ?? ''}${
        item.eligible ? '' : `  (${item.reason})`
      }`,
    );
    if (item.eligible) {
      for (const entry of item.entries.slice(0, 8)) {
        lines.push(
          `        ${humanBytes(entry.bytes).padStart(8)}  ${entry.name}${entry.kind === 'directory' ? '/' : ''}`,
        );
      }
    }
  }

  lines.push(`would free ${humanBytes(total)} from ${eligible.length} session(s) — nothing was deleted`);
  return lines.join('\n');
}

/** The result of a real sweep; partial deletion failures remain visible. */
export function renderScratchSweep(result: ScratchSweepView): string {
  const failures = result.failures === 0 ? '' : `; ${result.failures} entr(ies) could not be removed (see daemon log)`;
  return `reclaimed ${humanBytes(result.bytes)} from ${result.sessions} session(s)${failures}`;
}
