import type { config } from '@ferretry/kernel/host';

/** One held edit, as the daemon and the disk both report it. */
export interface PendingEdit {
  readonly path: string;
  readonly etag: string;
  readonly changes: readonly string[];
}

/** What a check or a status comes to: how many files, every problem, every edit waiting for the owner. */
export interface ConfigReport {
  readonly files: number;
  readonly issues: readonly config.ConfigIssue[];
  readonly pending: readonly PendingEdit[];
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

/** One issue as a line a person (or an agent) can jump to: `path:line:col severity: message`, then the fix. */
export function renderIssue(issue: config.ConfigIssue): string {
  const where = issue.line === undefined ? issue.path : `${issue.path}:${String(issue.line)}:${String(issue.column)}`;
  return `${where} ${issue.severity}: ${issue.message}\n  fix: ${issue.fix}`;
}

/** One held edit, and the command that confirms it. */
export function renderPending(pending: PendingEdit, bin: string): string {
  return `${pending.path} waits for your confirmation: ${pending.changes.join('; ')}\n  confirm: ${bin} config confirm ${pending.path}`;
}

/** The whole report: every issue, every held edit, and one summary line. */
export function renderConfigReport(report: ConfigReport, bin: string): string {
  const errors = report.issues.filter(issue => issue.severity === 'error').length;
  const warnings = report.issues.length - errors;
  return [
    ...report.issues.map(renderIssue),
    ...report.pending.map(pending => renderPending(pending, bin)),
    `${plural(report.files, 'file')} checked: ${plural(errors, 'error')}, ${plural(warnings, 'warning')}, ${String(report.pending.length)} waiting for confirmation.`,
  ].join('\n');
}
