import { describe, it } from 'bun:test';
import should from 'should';
import type { PwaPerformanceReport, RouteStats } from '../../../src/lib/performance/recorder.ts';
import { PerformanceRecorder } from '../../../src/lib/performance/recorder.ts';
import {
  bytesText,
  durationText,
  exposePerformanceReport,
  type PerformanceReportReader,
  renderPwaPerformanceReport,
} from '../../../src/lib/performance/report-text.ts';

const route = (name: string, count: number): RouteStats => ({
  route: name,
  count,
  perMinute: count / 5,
  p50Ms: 42.4,
  p95Ms: 120,
  maxMs: 300.6,
  bytesIn: count * 2_048,
  bytesOut: 0,
  failed: 0,
});

const quiet: PwaPerformanceReport = {
  windowMs: 300_000,
  coveredMs: 300_000,
  requests: { count: 0, perMinute: 0, bytesIn: 0, bytesOut: 0, failed: 0 },
  routes: [],
  streams: [],
  longTasks: { observed: false, count: 0, totalMs: 0, maxMs: 0 },
  renders: [],
};

describe('renderPwaPerformanceReport', () => {
  it('should say a quiet window in three lines, and that long tasks were not reported', () => {
    // Act
    const actual = renderPwaPerformanceReport(quiet);

    // Assert
    should(actual).equal(
      [
        'This browser — last 5 min',
        'Requests: 0 (0.0/min), 0 B in, 0 B out, 0 failed',
        '',
        'Long tasks: not reported by this browser',
      ].join('\n'),
    );
  });

  it('should render the route table, streams, long tasks and renders, aligned', () => {
    // Arrange
    const report: PwaPerformanceReport = {
      ...quiet,
      coveredMs: 125_000,
      requests: { count: 13, perMinute: 6.2, bytesIn: 26_624, bytesOut: 120, failed: 1 },
      routes: [route('GET /v1/sessions', 10), { ...route('GET /v1/usage', 3), failed: 1 }],
      streams: [{ route: 'STREAM /v1/events', opened: 1 }],
      longTasks: { observed: true, count: 2, totalMs: 210, maxMs: 150 },
      renders: [{ surface: 'session', count: 4, p50Ms: 3, p95Ms: 12.2, maxMs: 12.2 }],
    };

    // Act
    const actual = renderPwaPerformanceReport(report);

    // Assert
    should(actual).equal(
      [
        'This browser — last 5 min (recorded 2 min 5 s of it)',
        'Requests: 13 (6.2/min), 26.0 KB in, 120 B out, 1 failed',
        '',
        'Route             Count  /min    p50     p95     Max       In  Failed',
        'GET /v1/sessions     10   2.0  42 ms  120 ms  301 ms  20.0 KB       0',
        'GET /v1/usage         3   0.6  42 ms  120 ms  301 ms   6.0 KB       1',
        '',
        'Streams opened: STREAM /v1/events ×1',
        '',
        'Long tasks (main thread busy ≥ 50 ms): 2, 210 ms in all, longest 150 ms',
        '',
        'Render   Count   p50    p95    Max',
        'session      4  3 ms  12 ms  12 ms',
      ].join('\n'),
    );
  });

  it('should cap the route table and say how many it left out', () => {
    // Arrange
    const many = { ...quiet, routes: [route('GET /a', 3), route('GET /b', 2), route('GET /c', 1)] };
    const one = { ...quiet, routes: [route('GET /a', 3), route('GET /b', 2)] };

    // Act
    const capped = renderPwaPerformanceReport(many, 1);
    const single = renderPwaPerformanceReport(one, 1);

    // Assert
    should(capped).containEql('… and 2 more routes');
    should(single).containEql('… and 1 more route\n');
  });

  it('should say an observed quiet main thread as none', () => {
    // Act
    const actual = renderPwaPerformanceReport({ ...quiet, longTasks: { ...quiet.longTasks, observed: true } });

    // Assert
    should(actual).endWith('Long tasks (main thread busy ≥ 50 ms): 0');
  });
});

describe('durationText', () => {
  it('should say a window the way a person does', () => {
    // Act
    const actual = [45_000, 60_000, 252_000, 3_600_000, 3_780_000].map(durationText);

    // Assert
    should(actual).eql(['45 s', '1 min', '4 min 12 s', '1 h', '1 h 3 min']);
  });
});

describe('bytesText', () => {
  it('should pick the unit a person reads', () => {
    // Act
    const actual = [812, 14_540, 3_250_586].map(bytesText);

    // Assert
    should(actual).eql(['812 B', '14.2 KB', '3.1 MB']);
  });
});

describe('exposePerformanceReport', () => {
  it('should put a reader on the page that renders the recorder’s report, five minutes by default', () => {
    // Arrange
    let time = 0;
    const recorder = new PerformanceRecorder({ now: () => time });
    const page: { fyPerformanceReport?: PerformanceReportReader } = {};
    time = 600_000;

    // Act
    exposePerformanceReport(recorder, page);
    exposePerformanceReport(undefined, page);

    // Assert — the second call, with no recorder, left the first reader in place.
    should(page.fyPerformanceReport?.()).startWith('This browser — last 5 min\n');
    should(page.fyPerformanceReport?.(60_000)).startWith('This browser — last 1 min\n');
  });

  it('should put it on the global page by default', () => {
    // Arrange
    const page = globalThis as { fyPerformanceReport?: PerformanceReportReader };

    // Act
    exposePerformanceReport(new PerformanceRecorder({ now: () => 0 }));
    const actual = page.fyPerformanceReport?.(1_000);
    delete page.fyPerformanceReport;

    // Assert
    should(actual).startWith('This browser — last 1 s');
  });
});
