/**
 * THE PWA'S HALF OF THE PERFORMANCE REPORT, AS TEXT A PERSON CAN PASTE.
 *
 * Shown in Settings › Machine › Diagnostics beside the daemon's own report, and written for the same
 * reader: someone asking "why is it slow" who needs the answer in one screen. So it leads with the
 * request rate (the most common cause), then the routes that make it up, then the main thread.
 *
 * Pure: the same report always renders the same text, so it can be tested as text and copied as is.
 */

import type { PerformanceRecorder, PwaPerformanceReport, RouteStats } from './recorder.ts';

/** `4 min 12 s`, `45 s`, `1 h 3 min`: a window as a person says it. */
export const durationText = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${String(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return seconds % 60 === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds % 60)} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes % 60)} min`;
};

/** `812 B`, `14.2 KB`, `3.1 MB`. */
export const bytesText = (bytes: number): string => {
  if (bytes < 1_024) return `${String(bytes)} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
};

const milliseconds = (value: number): string => `${String(Math.round(value))} ms`;

/** The route table's columns, padded so the text lines up in a monospace panel. */
const ROUTE_HEADER = ['Route', 'Count', '/min', 'p50', 'p95', 'Max', 'In', 'Failed'] as const;

const routeCells = (route: RouteStats): readonly string[] => [
  route.route,
  String(route.count),
  route.perMinute.toFixed(1),
  milliseconds(route.p50Ms),
  milliseconds(route.p95Ms),
  milliseconds(route.maxMs),
  bytesText(route.bytesIn),
  String(route.failed),
];

const table = (rows: readonly (readonly string[])[]): string[] => {
  const widths = (rows[0] ?? []).map((_, column) => Math.max(...rows.map(row => (row[column] ?? '').length)));
  return rows.map(row =>
    row
      .map((cell, column) => (column === 0 ? cell.padEnd(widths[column] ?? 0) : cell.padStart(widths[column] ?? 0)))
      .join('  ')
      .trimEnd(),
  );
};

/** The whole report as plain text, newest window first; the routes are capped at `maxRoutes`. */
export const renderPwaPerformanceReport = (report: PwaPerformanceReport, maxRoutes = 20): string => {
  const lines: string[] = [];
  const covered =
    report.coveredMs < report.windowMs - 1_000
      ? `last ${durationText(report.windowMs)} (recorded ${durationText(report.coveredMs)} of it)`
      : `last ${durationText(report.windowMs)}`;
  lines.push(`This browser — ${covered}`);
  const { requests } = report;
  lines.push(
    `Requests: ${String(requests.count)} (${requests.perMinute.toFixed(1)}/min), ${bytesText(requests.bytesIn)} in, ` +
      `${bytesText(requests.bytesOut)} out, ${String(requests.failed)} failed`,
  );
  if (report.routes.length > 0) {
    lines.push('');
    lines.push(...table([ROUTE_HEADER, ...report.routes.slice(0, maxRoutes).map(routeCells)]));
    const hidden = report.routes.length - maxRoutes;
    if (hidden > 0) lines.push(`… and ${String(hidden)} more route${hidden === 1 ? '' : 's'}`);
  }
  if (report.streams.length > 0) {
    lines.push('');
    lines.push(
      `Streams opened: ${report.streams.map(stream => `${stream.route} ×${String(stream.opened)}`).join(', ')}`,
    );
  }
  lines.push('');
  const { longTasks } = report;
  lines.push(
    longTasks.observed
      ? `Long tasks (main thread busy ≥ 50 ms): ${String(longTasks.count)}` +
          (longTasks.count === 0
            ? ''
            : `, ${milliseconds(longTasks.totalMs)} in all, longest ${milliseconds(longTasks.maxMs)}`)
      : 'Long tasks: not reported by this browser',
  );
  if (report.renders.length > 0) {
    lines.push('');
    lines.push(
      ...table([
        ['Render', 'Count', 'p50', 'p95', 'Max'],
        ...report.renders.map(render => [
          render.surface,
          String(render.count),
          milliseconds(render.p50Ms),
          milliseconds(render.p95Ms),
          milliseconds(render.maxMs),
        ]),
      ]),
    );
  }
  return lines.join('\n');
};

/** What the page offers a person at the console: the report text for the last `windowMs` (five minutes). */
export type PerformanceReportReader = (windowMs?: number) => string;

/**
 * Puts `fyPerformanceReport()` on the page, so the browser's half of the report can be read today —
 * from the console, or by a harness driving the page — before Settings has a panel for it. It prints
 * the same text the panel will, and it holds nothing a report does not already leave out.
 */
export const exposePerformanceReport = (
  recorder: PerformanceRecorder | undefined,
  target: { fyPerformanceReport?: PerformanceReportReader } = globalThis as {
    fyPerformanceReport?: PerformanceReportReader;
  },
): void => {
  if (recorder === undefined) return;
  target.fyPerformanceReport = (windowMs = 5 * 60_000) => renderPwaPerformanceReport(recorder.report(windowMs));
};
