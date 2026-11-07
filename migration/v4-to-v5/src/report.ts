/**
 * What the conversion did, item by item. Counts, ids and names only: a report never holds a value from a state
 * file, and never a byte of a sealed one (a sealed file is named with its size).
 */
export type StepStatus = 'converted' | 'pending' | 'not-carried' | 'failed';

export interface KeptItem {
  readonly what: string;
  readonly count: number;
}

export interface NotCarried {
  readonly what: string;
  readonly why: string;
}

export interface StepReport {
  readonly id: string;
  readonly title: string;
  readonly status: StepStatus;
  /** For `pending`: which v5 schema it waits for. For `failed`: the problem, with no file content in it. */
  readonly note?: string;
  readonly kept: readonly KeptItem[];
  readonly notCarried: readonly NotCarried[];
  readonly sealed: readonly { readonly file: string; readonly bytes: number }[];
}

export interface ConversionReport {
  readonly format: 1;
  readonly tool: 'ferretry-v4-to-v5';
  readonly from: string;
  readonly to: string;
  readonly at: string;
  readonly dryRun: boolean;
  readonly steps: readonly StepReport[];
  /** True only when every step converted or was declared not carried, and home.json was written. */
  readonly complete: boolean;
}

export function summarise(report: ConversionReport): string {
  const lines = report.steps.map(step => {
    const kept = step.kept.map(item => `${item.count} ${item.what}`).join(', ');
    const sealed = step.sealed.length > 0 ? `; ${step.sealed.length} sealed file(s) moved unopened` : '';
    const note = step.note === undefined ? '' : ` — ${step.note}`;
    return `  ${step.status.padEnd(11)} ${step.title}${kept === '' ? '' : `: ${kept}`}${sealed}${note}`;
  });
  const verdict = report.complete
    ? 'complete: home.json written, v5 may start on this home'
    : 'NOT complete: home.json was not written, so v5 refuses this folder (by design)';
  return [`v4 -> v5 conversion ${report.dryRun ? '(dry run) ' : ''}${verdict}`, ...lines].join('\n');
}
