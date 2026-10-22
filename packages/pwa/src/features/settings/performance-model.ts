/**
 * What the Performance panel says and hands over, as pure functions of the two reports.
 *
 * The daemon's report and this browser's are SEPARATE documents and stay separate: each is already free
 * of content and secrets (the daemon's by `performance-redaction.ts`, this browser's by
 * `lib/performance/route-pattern.ts`), and joining them changes neither. The text is the daemon's own
 * renderer — the same one `fy daemon profile` prints — then this browser's, so a report pasted from the
 * panel reads exactly like one pasted from a terminal, with the app's half after it.
 */

import { type BudgetVerdict, type PerformanceReport, renderPerformanceReport } from '@ferretry/protocol';
import type { PwaPerformanceReport } from '../../lib/performance/recorder.ts';
import { renderPwaPerformanceReport } from '../../lib/performance/report-text.ts';

/** One recording: the machine's report, and this browser's over the same seconds when it has a recorder. */
export interface PerformanceRecording {
  readonly daemon: PerformanceReport;
  readonly pwa: PwaPerformanceReport | null;
}

/** Said where this browser's half would be, for an app opened without a recorder (a harness, a suite). */
export const PWA_REPORT_UNAVAILABLE = 'This browser — not recorded: this page has no recorder.';

/** The whole recording as text, for Copy report. */
export const performanceReportText = (recording: PerformanceRecording): string =>
  `${renderPerformanceReport(recording.daemon)}\n\n${
    recording.pwa === null ? PWA_REPORT_UNAVAILABLE : renderPwaPerformanceReport(recording.pwa)
  }\n`;

/** The whole recording as one JSON document, for Download JSON: `{ daemon, pwa }`. */
export const performanceReportJson = (recording: PerformanceRecording): string =>
  `${JSON.stringify({ daemon: recording.daemon, pwa: recording.pwa }, null, 2)}\n`;

/** `ferretry-performance-2026-10-22T01-30-00Z.json`: when the window ended, and nothing about whose machine. */
export const performanceFileName = (recording: PerformanceRecording): string => {
  const ended = recording.daemon.endedAt.replace(/\.\d+(?=Z$)/u, '').replace(/[:.]/gu, '-');
  return `ferretry-performance-${ended}.json`;
};

/** The budgets this window broke, in the order the daemon listed them. */
export const brokenBudgets = (report: PerformanceReport): readonly BudgetVerdict[] =>
  report.budgets.filter(budget => !budget.ok);

/** `45 / min` against `limit 30 / min`, the way a budget line reads in the panel. */
export const budgetWords = (budget: BudgetVerdict): string => {
  const figure = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1));
  return `${figure(budget.actual)} ${budget.unit} (limit ${figure(budget.limit)})`;
};

/** Whole seconds left in a window that started `elapsedMs` ago and lasts `totalMs`; never below zero. */
export const secondsLeft = (elapsedMs: number, totalMs: number): number =>
  Math.max(0, Math.ceil((totalMs - elapsedMs) / 1_000));

/** How far through the window, 0 to 100. */
export const percentDone = (elapsedMs: number, totalMs: number): number =>
  totalMs <= 0 ? 100 : Math.min(100, Math.max(0, Math.round((elapsedMs / totalMs) * 100)));

/** Why a profile could not be taken, as the panel says it. */
export type ProfileFailure =
  | { readonly kind: 'refused'; readonly reason: string }
  | { readonly kind: 'lost'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string };

export const PROFILE_REFUSED_INTRO =
  'This device may not profile this machine: a performance report describes the machine, so it is for devices with operator access.';
export const PROFILE_REFUSED_REMEDY =
  'Run fy daemon profile in a terminal on the machine itself, or record from a device with operator access.';
export const PROFILE_LOST_SENTENCE =
  'The machine no longer has this recording — it most likely restarted during the window. Record again.';
export const PROFILE_TOO_SLOW_SENTENCE = 'The machine did not finish its report in time. Record again.';

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause)).trim();

/** A refusal (403), a recording the daemon no longer has (404), or anything else, said plainly. */
export const profileFailure = (cause: unknown): ProfileFailure => {
  const status = (cause as { readonly status?: unknown } | null)?.status;
  if (status === 403) return { kind: 'refused', reason: reasonOf(cause) };
  if (status === 404) return { kind: 'lost', reason: PROFILE_LOST_SENTENCE };
  const reason = reasonOf(cause);
  return { kind: 'failed', reason: reason === '' ? 'The machine did not say why.' : reason };
};
