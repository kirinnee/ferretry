import type { OnboardingView, StepState, StepView } from '../../contract/index.ts';
import type { Reading } from './checks.ts';
import { ALL_SET } from './words.ts';

/** What this run did to one step. */
export interface StepReport {
  readonly step: StepView;
  /** The sentence beside the step: what its check saw, or where it stands. */
  readonly line: string;
  readonly check: 'settled' | 'found' | 'missing' | 'unchecked' | 'unreachable';
  /** What to do about a step that is still missing. */
  readonly remedy?: string;
  /** The found sign-in is the terminal's own, linked: the costs line follows. */
  readonly linked?: true;
}

interface NextStep {
  readonly step: string;
  readonly why: string;
}

/** Everything `onboard` found, in the shape `--json` prints. It has no field for a credential or a code. */
export interface OnboardSummary {
  readonly schema: 1;
  readonly complete: boolean;
  /** 0 every step settled, 2 waiting for a person. */
  readonly exitCode: 0 | 2;
  readonly steps: readonly {
    readonly plugin: string;
    readonly id: string;
    readonly title: string;
    readonly order: number;
    readonly state: StepState;
    readonly check: StepReport['check'];
    readonly line: string;
  }[];
  readonly linkedSignIn: boolean;
  readonly next: readonly NextStep[];
}

const OK = '✓';
const AGENDA = '!';
const DASH = '-';

const SETTLED_WORD: Readonly<Record<StepState, string>> = {
  pending: 'not looked at yet',
  found: 'found',
  later: 'left for later',
  done: 'done',
  skipped: 'skipped',
};

const mark = (state: StepState): string =>
  state === 'pending' ? AGENDA : state === 'later' || state === 'skipped' ? DASH : OK;

/** One aligned status row. */
export function row(step: StepView, line: string, width: number): string {
  return `  ${mark(step.state)} ${step.title.padEnd(width)}  ${line}`;
}

export const titleWidth = (steps: readonly StepView[]): number => Math.max(0, ...steps.map(step => step.title.length));

/** The sentence beside a step in `onboard status`, which looks at nothing. */
export function statusLine(step: StepView): string {
  return SETTLED_WORD[step.state];
}

/** The line a step gets while a run is on it. */
export function reportLine(report: StepReport): string {
  const { step } = report;
  if (report.check === 'settled') return statusLine(step);
  if (step.state === 'found') return `found: ${report.line}`;
  if (step.state === 'later') return `${report.line} Left for later.`;
  if (step.state === 'skipped') return `${report.line} Skipped.`;
  return report.line;
}

/** The result of a reading, as the sentence and what to do: a pure mapping the controller and the tests share. */
export function reportOf(step: StepView, reading: Reading | undefined): StepReport {
  if (reading === undefined) return { step, line: 'Nothing to look for here.', check: 'unchecked' };
  if (reading.kind === 'found')
    return { step, line: reading.line, check: 'found', ...(reading.linked === true ? { linked: true as const } : {}) };
  if (reading.kind === 'missing') return { step, line: reading.line, check: 'missing', remedy: reading.remedy };
  return { step, line: `Could not check (${reading.reason}).`, check: 'unreachable' };
}

export function summarize(reports: readonly StepReport[]): OnboardSummary {
  const pending = reports.filter(report => report.step.state === 'pending');
  return {
    schema: 1,
    complete: pending.length === 0,
    exitCode: pending.length === 0 ? 0 : 2,
    steps: reports.map(({ step, check, line }) => ({
      plugin: step.plugin,
      id: step.id,
      title: step.title,
      order: step.order,
      state: step.state,
      check,
      line: reportLine({ step, check, line }),
    })),
    linkedSignIn: reports.some(report => report.linked === true),
    next: pending.flatMap(report =>
      report.remedy === undefined ? [] : [{ step: report.step.title, why: report.remedy }],
    ),
  };
}

/** The closing report: rows are printed as each step is settled, so this is only the sentence and the next steps. */
export function renderClosing(summary: OnboardSummary): string {
  const lines: string[] = [];
  const left = summary.steps.filter(step => step.state === 'later');
  lines.push(
    summary.complete
      ? ALL_SET
      : `${String(summary.steps.filter(step => step.state === 'pending').length)} of ${String(summary.steps.length)} steps still need you.`,
  );
  if (left.length > 0) lines.push(`Left for later: ${left.map(step => step.title).join(', ')}.`);
  if (summary.next.length > 0) {
    lines.push('', 'Next:');
    summary.next.forEach((step, index) => {
      lines.push(`  ${String(index + 1)}. ${step.step}: ${step.why}`);
    });
  }
  return lines.join('\n');
}

/** The `--json` contract. A versioned object, so an agent can branch on `complete` and read `next`. */
export function renderSummaryJson(summary: OnboardSummary): string {
  return JSON.stringify(summary, null, 2);
}

/** `onboard status`: the steps and where each stands, nothing checked and nothing changed. */
export function renderStatus(view: OnboardingView): string {
  const width = titleWidth(view.steps);
  return [
    view.complete ? ALL_SET : 'The first run is not finished.',
    '',
    ...view.steps.map(step => row(step, statusLine(step), width)),
  ].join('\n');
}
