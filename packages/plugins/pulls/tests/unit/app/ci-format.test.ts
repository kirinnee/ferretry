import { describe, expect, test } from 'bun:test';
import {
  anyLive,
  barMs,
  drawnSpan,
  formatDuration,
  jobFrame,
  MIN_BAR_PERCENT,
  opensByDefault,
  orderRuns,
  runsSummary,
  stepSpan,
  triggerWord,
} from '../../../app/features/ci-run/ci-format.ts';
import { checkRun, failedRun, NOW, passingRun, runningRun } from '../../fixtures/ci-run-views.ts';

describe('formatDuration', () => {
  test('says seconds, minutes and hours the way a person does', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(185_000)).toBe('3m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });
});

describe('triggerWord', () => {
  test('names the common events and shows an unknown one as GitHub spelled it', () => {
    expect(triggerWord('pull_request')).toBe('Pull request');
    expect(triggerWord('workflow_dispatch')).toBe('Manual');
    expect(triggerWord('merge_group')).toBe('merge group');
  });
});

describe('bars', () => {
  test('a live bar ends now; a finished one at its end; a bar-less item has no length', () => {
    const running = runningRun();
    const live = running.jobs.find(job => job.live === true);
    expect(live).toBeDefined();
    expect(barMs(live ?? {}, NOW + 60_000)).toBe(Date.parse(NOW_ISO(NOW + 60_000)) - Date.parse(live?.start ?? ''));
    const queued = running.jobs.find(job => job.status === 'queued');
    expect(barMs(queued ?? {}, NOW)).toBeUndefined();
    const done = passingRun().jobs[0];
    expect(barMs(done ?? {}, NOW)).toBe(40_000);
  });

  test('a step sits inside its job: left edge and width are shares of the job', () => {
    const job = passingRun().jobs.find(candidate => candidate.name === 'test (ubuntu)');
    const frame = jobFrame(job ?? ({} as never), NOW);
    expect(frame?.length).toBe(286_000);
    const unit = job?.steps.find(step => step.name === 'Unit tests');
    const span = stepSpan(unit ?? ({} as never), frame, NOW);
    expect(span?.left).toBeCloseTo((30 / 286) * 100, 5);
    expect(span?.width).toBeCloseTo((236 / 286) * 100, 5);
  });

  test('a skipped step has no span, and a one-second step is still drawn', () => {
    const failed = failedRun();
    const test = failed.jobs.find(job => job.name === 'test (ubuntu)');
    const skipped = test?.steps.find(step => step.status === 'skipped');
    expect(stepSpan(skipped ?? ({} as never), jobFrame(test ?? ({} as never), NOW), NOW)).toBeUndefined();
    expect(drawnSpan({ left: 99.9, width: 0.1 })).toEqual({ left: 100 - MIN_BAR_PERCENT, width: MIN_BAR_PERCENT });
    expect(drawnSpan({ left: 10, width: 30 })).toEqual({ left: 10, width: 30 });
  });
});

describe('the run list', () => {
  test('failing first, then running, then the rest, each newest first', () => {
    const order = orderRuns([passingRun(), runningRun(), failedRun(), checkRun()]).map(run => run.id);
    expect(order).toEqual([1002, 1003, 1001, 77].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(order.slice(0, 2)).toEqual([1002, 1003]);
  });

  test('the summary counts runs, failures and work in progress', () => {
    expect(runsSummary([])).toBe('No CI runs');
    expect(runsSummary([passingRun()])).toBe('1 run');
    expect(runsSummary([passingRun(), failedRun(), runningRun()])).toBe('3 runs · 1 failed · 1 in progress');
  });

  test('anything still moving makes the run live; a failed or running job opens by itself', () => {
    expect(anyLive([passingRun(), failedRun()])).toBe(false);
    expect(anyLive([passingRun(), runningRun()])).toBe(true);
    expect(failedRun().jobs.map(opensByDefault)).toEqual([false, true]);
    expect(runningRun().jobs.map(opensByDefault)).toEqual([false, true, false]);
  });
});

function NOW_ISO(ms: number): string {
  return new Date(ms).toISOString();
}
