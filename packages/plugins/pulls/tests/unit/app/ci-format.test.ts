import { describe, expect, test } from 'bun:test';
import {
  anyLive,
  barMs,
  checkHref,
  DEFAULT_OPEN_JOBS,
  drawnSpan,
  formatDuration,
  jobFrame,
  isCheck,
  MIN_BAR_PERCENT,
  needLookCount,
  opensByDefault,
  orderRuns,
  runsSummary,
  stepSpan,
  triggerWord,
} from '../../../app/features/ci-run/ci-format.ts';
import type { CiJob, CiRun } from '../../../contract/wire.ts';
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
    expect(triggerWord('schedule')).toBe('Schedule');
    expect(triggerWord('workflow_call')).toBe('Called');
    expect(triggerWord('merge_group')).toBe('merge group');
  });
});

describe('bars', () => {
  test('a live bar ends now; a finished one at its end; a bar-less item has no length', () => {
    const running = runningRun();
    const live = running.jobs.find(job => job.live === true);
    expect(live).toBeDefined();
    expect(barMs(live ?? {}, NOW + 60_000, true)).toBe(
      Date.parse(NOW_ISO(NOW + 60_000)) - Date.parse(live?.start ?? ''),
    );
    const queued = running.jobs.find(job => job.status === 'queued');
    expect(barMs(queued ?? {}, NOW, true)).toBeUndefined();
    const done = passingRun().jobs[0];
    expect(barMs(done ?? {}, NOW, true)).toBe(40_000);
  });

  test('a step sits inside its job: left edge and width are shares of the job', () => {
    const job = passingRun().jobs.find(candidate => candidate.name === 'test (ubuntu)');
    const frame = jobFrame(job ?? ({} as never), NOW, true);
    expect(frame?.length).toBe(286_000);
    const unit = job?.steps.find(step => step.name === 'Unit tests');
    const span = stepSpan(unit ?? ({} as never), frame, NOW, true);
    expect(span?.left).toBeCloseTo((30 / 286) * 100, 5);
    expect(span?.width).toBeCloseTo((236 / 286) * 100, 5);
  });

  test('a skipped step has no span, and a one-second step is still drawn', () => {
    const failed = failedRun();
    const test = failed.jobs.find(job => job.name === 'test (ubuntu)');
    const skipped = test?.steps.find(step => step.status === 'skipped');
    expect(stepSpan(skipped ?? ({} as never), jobFrame(test ?? ({} as never), NOW, false), NOW, false)).toBeUndefined();
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
    expect(failedRun().jobs.map(job => opensByDefault(failedRun().jobs).has(job.id))).toEqual([false, true]);
    expect(runningRun().jobs.map(job => opensByDefault(runningRun().jobs).has(job.id))).toEqual([false, true, false]);
  });

  test('only a few jobs open by themselves: failed ones first, then running ones, in the run’s order', () => {
    const job = (id: number, status: CiJob['status']): CiJob => ({
      id,
      name: `j${id}`,
      status,
      queuedMs: 0,
      steps: [],
    });
    const jobs = [
      job(1, 'running'),
      job(2, 'passed'),
      job(3, 'failed'),
      job(4, 'failed'),
      job(5, 'running'),
      job(6, 'failed'),
      job(7, 'failed'),
    ];
    expect([...opensByDefault(jobs)]).toEqual([3, 4, 6, 7]);
    expect(DEFAULT_OPEN_JOBS).toBe(4);
    expect(needLookCount(jobs)).toBe(6);
    expect([...opensByDefault([job(1, 'queued'), job(2, 'passed')])]).toEqual([]);
  });
});

describe('one bounded duration', () => {
  const stale = () => ({ start: NOW_ISO(NOW - 100_000), end: NOW_ISO(NOW - 98_000), live: true });

  test('a live item ticks to now only while every level above it is live; else it keeps E8’s bounded end', () => {
    const step = stale();
    expect(barMs(step, NOW + 3_600_000, true)).toBe(3_700_000);
    // The job (or the run) stopped: E8 clamped this step to 2 s, and an hour on the browser clock does not grow it.
    expect(barMs(step, NOW + 3_600_000, false)).toBe(2_000);
    expect(barMs({ start: NOW_ISO(NOW), live: true }, NOW + 5_000, false)).toBe(5_000);
  });

  test('label and bar share one length: a clamped step in a stopped job is 2 s wide and says 2s', () => {
    const job: CiJob = {
      id: 1,
      name: 'j',
      status: 'cancelled',
      queuedMs: 0,
      start: NOW_ISO(NOW - 100_000),
      end: NOW_ISO(NOW - 50_000),
      live: true,
      steps: [],
    };
    const step = { name: 's', number: 1, status: 'running' as const, ...stale() };
    const later = NOW + 600_000;
    const frame = jobFrame(job, later, false);
    expect(frame?.length).toBe(50_000);
    const span = stepSpan(step, frame, later, false);
    expect(span?.width).toBeCloseTo((2_000 / 50_000) * 100, 5);
    expect(formatDuration(barMs(step, later, false) ?? 0)).toBe('2s');
  });
});

describe('a check from another CI', () => {
  const withUrl = (url: string | undefined): CiRun => {
    const { url: _drop, ...rest } = checkRun();
    return url === undefined ? rest : { ...rest, url };
  };

  test('is a check by its trigger and by having no jobs, never an Actions run', () => {
    expect(isCheck(checkRun())).toBe(true);
    expect(isCheck(passingRun())).toBe(false);
  });

  test('links only to an https github.com page of its own', () => {
    expect(checkHref(withUrl('https://github.com/octo/hello/runs/77'))).toBe('https://github.com/octo/hello/runs/77');
    expect(checkHref(withUrl('http://github.com/octo/hello/runs/77'))).toBeUndefined();
    expect(checkHref(withUrl('https://ci.example.test/builds/77'))).toBeUndefined();
    expect(checkHref(withUrl('https://github.com.evil.test/x'))).toBeUndefined();
    expect(checkHref(withUrl('https://user:pw@github.com/x'))).toBeUndefined();
    expect(checkHref(withUrl('javascript:alert(1)'))).toBeUndefined();
    expect(checkHref(withUrl('not a url'))).toBeUndefined();
    expect(checkHref(withUrl(undefined))).toBeUndefined();
  });
});

function NOW_ISO(ms: number): string {
  return new Date(ms).toISOString();
}
