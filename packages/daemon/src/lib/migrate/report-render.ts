import type { InflightReport } from './inflight-report.ts';
import { age, escapeCell, truncate, verdictLabels } from './render-text.ts';

/** Compact terminal table, printed on a refusal and on a report-writing proceed. */
export function renderInflightCli(report: InflightReport): string {
  const lines: string[] = [
    `in-flight inventory — status ${report.status}, turn ${report.turn}, worst: ${verdictLabels[report.worstVerdict]}`,
  ];
  for (const tool of report.openTools)
    lines.push(`  tool  [${verdictLabels[tool.verdict]}] ${tool.name}: ${truncate(tool.summary, 90)}`);
  for (const entry of report.processes)
    lines.push(
      `  proc  [${verdictLabels[entry.verdict]}] pid ${entry.pid} (${age(entry.startedSecondsAgo)}): ${truncate(entry.argv, 90)}`,
    );
  if (report.codexBackgroundTerminals > 0)
    lines.push(`  codex ${report.codexBackgroundTerminals} background terminal(s) [UNKNOWN — no argv, unaccountable]`);
  for (const blindSpot of report.blindSpots) lines.push(`  blind [UNKNOWN] ${blindSpot}`);
  if (nothingObserved(report)) lines.push('  (no open tools or descendant processes observed)');
  return lines.join('\n');
}

function nothingObserved(report: InflightReport): boolean {
  return (
    report.openTools.length === 0 &&
    report.processes.length === 0 &&
    report.codexBackgroundTerminals === 0 &&
    report.blindSpots.length === 0
  );
}

export interface ReportMeta {
  readonly sessionId: string;
  readonly targetAgent: string;
  readonly targetModel?: string;
  readonly forced: boolean;
  /** ISO timestamp; the caller passes the clock reading so this module stays deterministic. */
  readonly at: string;
}

/**
 * The markdown written to the session's `migration-inflight.md` — the handoff note AND the forensic
 * record of what a forced migration destroyed.
 *
 * This half is written BEFORE the migration is attempted, so it must never claim the move happened:
 * at this point the target is REQUESTED, not reached. The settled truth is appended afterwards by
 * `renderMigrationOutcome`.
 */
export function renderInflightReport(report: InflightReport, meta: ReportMeta): string {
  const model = meta.targetModel ? ` (model \`${meta.targetModel}\`)` : '';
  const lines: string[] = [
    '# Migration in-flight report',
    '',
    `- Session: \`${meta.sessionId}\``,
    `- Migration requested onto: \`${meta.targetAgent}\`${model} — **PENDING at the time this section was ` +
      'written; see the Outcome section below for what actually happened.**',
    `- Requested at: ${meta.at}`,
    `- Status at migrate: ${report.status} (turn ${report.turn})`,
    `- Worst verdict: **${verdictLabels[report.worstVerdict]}**`,
  ];
  if (meta.forced)
    lines.push(
      '- **FORCED past a destructive/unknown refusal (`--force-inflight`).** The items below are killed by the ' +
        'relaunch if it proceeds.',
    );
  lines.push('', '## What was running', '');
  lines.push(
    ...openToolSection(report),
    ...processSection(report),
    ...codexSection(report),
    ...blindSpotSection(report),
  );
  if (nothingObserved(report)) lines.push('_No open tools or descendant processes were observed at migrate time._', '');
  lines.push(...guidance());
  return `${lines.join('\n')}\n`;
}

function openToolSection(report: InflightReport): readonly string[] {
  if (report.openTools.length === 0) return [];
  return [
    '### Open harness tools',
    '',
    '| verdict | tool | command / input |',
    '|---|---|---|',
    ...report.openTools.map(
      tool => `| ${verdictLabels[tool.verdict]} | ${escapeCell(tool.name)} | \`${escapeCell(tool.summary)}\` |`,
    ),
    '',
  ];
}

function processSection(report: InflightReport): readonly string[] {
  if (report.processes.length === 0) return [];
  return [
    '### Descendant processes (pane-pid tree)',
    '',
    '| verdict | pid | age | cwd | argv |',
    '|---|---|---|---|---|',
    ...report.processes.map(
      entry =>
        `| ${verdictLabels[entry.verdict]} | ${entry.pid} | ${age(entry.startedSecondsAgo)} | ` +
        `${entry.cwd ? `\`${escapeCell(entry.cwd)}\`` : '?'} | \`${escapeCell(entry.argv)}\` |`,
    ),
    '',
  ];
}

function codexSection(report: InflightReport): readonly string[] {
  if (report.codexBackgroundTerminals === 0) return [];
  return [
    `### Codex background terminals: ${report.codexBackgroundTerminals}`,
    '',
    'Their children are NOT under the pane pid and carry no argv — they are **unaccountable**. Treat as unknown: ' +
      'check the pane for what they were doing before re-running anything.',
    '',
  ];
}

/** What the inspection could not rule out. Absent from the source module; a refusal is unactionable
 *  without it, because "we could not look" needs different follow-up from "we looked and it is bad". */
function blindSpotSection(report: InflightReport): readonly string[] {
  if (report.blindSpots.length === 0) return [];
  return [
    '### Blind spots',
    '',
    'The inspection could not rule these out, so the work they might hide is **unaccounted for**:',
    '',
    ...report.blindSpots.map(blindSpot => `- ${escapeCell(blindSpot)}`),
    '',
  ];
}

function guidance(): readonly string[] {
  return [
    '## What to do now (per class)',
    '',
    '- **safe**: read-only/ephemeral (rg, ls, sleep …). Killed by the relaunch; ignore.',
    '- **re-armable**: idempotent (test suites, builds, linters …). Re-run only if still needed.',
    '- **DESTRUCTIVE**: state-mutating / non-idempotent (git commit/push/rebase, installs, nix/hms, tofu, kubectl, ' +
      'sops, rm/mv …). **Do NOT blindly re-run.** VERIFY state first — `git status`, half-applied changes, partial ' +
      'writes — then decide.',
    '- **UNKNOWN**: not recognized (incl. codex background terminals and blind spots). Inspect the pane/transcript ' +
      'before acting.',
    '',
  ];
}
