import { describe, expect, test } from 'bun:test';
import { CiRunSchema } from '../../contract/index.ts';
import {
  type ActionsJobInput,
  buildCheckRun,
  buildRun,
  durationMs,
  foldStatus,
  slowestStep,
} from '../../contract/ci-timing.ts';
import { readCheckRun, readJob, readRun } from '../../daemon/features/ci/payloads.ts';
import { T0, at, ghCheck, ghJob, ghRun, ghStep } from '../fixtures/fake-github/ci.ts';

const sec = (s: number) => T0 + s * 1000;
const run = (spec: Parameters<typeof ghRun>[0]) => {
  const read = readRun(ghRun(spec));
  if (read === undefined) throw new Error('fixture run did not parse');
  return read;
};
const jobs = (...specs: Parameters<typeof ghJob>[0][]): ActionsJobInput[] =>
  specs.map(spec => {
    const read = readJob(ghJob(spec));
    if (read === undefined) throw new Error('fixture job did not parse');
    return read;
  });

describe('foldStatus', () => {
  test('GitHub’s status and conclusion fold to one word; an unknown outcome is never a pass', () => {
    expect(foldStatus('queued', null)).toBe('queued');
    expect(foldStatus('waiting', null)).toBe('queued');
    expect(foldStatus('something_new', null)).toBe('queued');
    expect(foldStatus('in_progress', null)).toBe('running');
    expect(foldStatus('completed', 'success')).toBe('passed');
    expect(foldStatus('completed', 'neutral')).toBe('passed');
    expect(foldStatus('completed', 'failure')).toBe('failed');
    expect(foldStatus('completed', 'timed_out')).toBe('failed');
    expect(foldStatus('completed', 'startup_failure')).toBe('failed');
    expect(foldStatus('completed', 'cancelled')).toBe('cancelled');
    expect(foldStatus('completed', 'stale')).toBe('cancelled');
    expect(foldStatus('completed', 'skipped')).toBe('skipped');
    expect(foldStatus('completed', 'action_required')).toBe('queued');
    expect(foldStatus('completed', null)).toBe('failed');
    expect(foldStatus('completed', 'brand_new')).toBe('failed');
  });
});

describe('a passing run', () => {
  const built = buildRun(
    run({ id: 1, created: 0, started: 5, updated: 100 }),
    jobs(
      {
        id: 12,
        name: 'test',
        start: 12,
        end: 100,
        steps: [ghStep(1, { name: 'Run tests', start: 12, end: 100 })],
      },
      {
        id: 11,
        name: 'build',
        start: 10,
        end: 70,
        steps: [
          ghStep(1, { name: 'Set up', start: 10, end: 20 }),
          ghStep(2, { name: 'Compile', start: 20, end: 65 }),
          ghStep(3, { name: 'Post', start: 65, end: 70 }),
        ],
      },
    ),
    sec(300),
  );

  test('timing: queue to the first job, wall time to the last job end, jobs in start order', () => {
    expect(built).toMatchObject({
      id: 1,
      status: 'passed',
      trigger: 'pull_request',
      attempt: 1,
      createdAt: at(0).replace('Z', '.000Z'),
      queuedMs: 10_000,
      wallMs: 100_000,
    });
    expect(built.live).toBeUndefined();
    expect(built.start).toBe(at(5).replace('Z', '.000Z'));
    expect(built.end).toBe(at(100).replace('Z', '.000Z'));
    expect(built.jobs.map(job => job.name)).toEqual(['build', 'test']);
    expect(built.jobs.map(job => job.queuedMs)).toEqual([10_000, 12_000]);
    expect(built.jobs[0]?.steps.map(step => [step.name, durationMs(step, sec(300))])).toEqual([
      ['Set up', 10_000],
      ['Compile', 45_000],
      ['Post', 5_000],
    ]);
  });

  test('it fits the contract and names the slowest step across every job', () => {
    expect(CiRunSchema.safeParse(built).success).toBe(true);
    const slow = slowestStep(built, sec(300));
    expect(slow?.job.name).toBe('test');
    expect(slow?.step.name).toBe('Run tests');
  });
});

describe('a failed run', () => {
  test('the failed step fails its job and the run; the later steps that never ran are skipped with no bar', () => {
    const built = buildRun(
      run({ id: 2, conclusion: 'failure', updated: 60 }),
      jobs({
        id: 21,
        name: 'build',
        conclusion: 'failure',
        start: 10,
        end: 50,
        steps: [
          ghStep(1, { name: 'Compile', start: 10, end: 50, conclusion: 'failure' }),
          ghStep(2, { name: 'Post', status: 'completed', conclusion: 'skipped' }),
        ],
      }),
      sec(300),
    );
    expect(built.status).toBe('failed');
    expect(built.jobs[0]?.status).toBe('failed');
    const [compile, post] = built.jobs[0]?.steps ?? [];
    expect(compile?.status).toBe('failed');
    expect(post).toEqual({ name: 'Post', number: 2, status: 'skipped' });
    expect(CiRunSchema.safeParse(built).success).toBe(true);
  });
});

describe('a running run', () => {
  const now = sec(90);
  const built = buildRun(
    run({ id: 3, status: 'in_progress', conclusion: null, started: 5 }),
    jobs(
      {
        id: 31,
        name: 'build',
        start: 10,
        end: 40,
        steps: [ghStep(1, { name: 'Set up', start: 10, end: 40 })],
      },
      {
        id: 32,
        name: 'test',
        status: 'in_progress',
        conclusion: null,
        start: 40,
        end: null,
        steps: [
          ghStep(1, { name: 'Unit', start: 40, end: 70 }),
          ghStep(2, { name: 'Integration', status: 'in_progress', conclusion: null, start: 70 }),
          ghStep(3, { name: 'Report', status: 'queued', conclusion: null }),
        ],
      },
      { id: 33, name: 'deploy', status: 'queued', conclusion: null },
    ),
    now,
  );

  test('running items end at now and are flagged live; the run has no end', () => {
    expect(built).toMatchObject({ status: 'running', live: true, wallMs: 90_000, queuedMs: 10_000 });
    expect(built.end).toBeUndefined();
    const test = built.jobs.find(job => job.name === 'test');
    expect(test).toMatchObject({ live: true, end: new Date(now).toISOString() });
    const integration = test?.steps[1];
    expect(integration).toMatchObject({ live: true, end: new Date(now).toISOString() });
    expect(durationMs(integration ?? {}, now)).toBe(20_000);
  });

  test('a step that has not begun and a job still queued have no bar; the queued job waits until now', () => {
    const test = built.jobs.find(job => job.name === 'test');
    expect(test?.steps[2]).toEqual({ name: 'Report', number: 3, status: 'queued' });
    const deploy = built.jobs.find(job => job.name === 'deploy');
    expect(deploy).toMatchObject({ status: 'queued', queuedMs: 90_000, steps: [] });
    expect(deploy?.start).toBeUndefined();
    expect(CiRunSchema.safeParse(built).success).toBe(true);
  });

  test('nothing started: the run is queued and its queue time is creation to now', () => {
    const queued = buildRun(run({ id: 4, status: 'queued', conclusion: null, started: null }), [], now);
    expect(queued).toMatchObject({ status: 'queued', live: true, queuedMs: 90_000, wallMs: 90_000, jobs: [] });
    expect(queued.start).toBeUndefined();
  });
});

describe('a re-run', () => {
  test('attempt 2 measures from its own start, not from the first attempt’s creation', () => {
    const built = buildRun(
      run({ id: 5, attempt: 2, created: 0, started: 3600, updated: 3700 }),
      jobs({ id: 51, name: 'build', start: 3610, end: 3690 }),
      sec(4000),
    );
    expect(built.attempt).toBe(2);
    expect(built.createdAt).toBe(at(3600).replace('Z', '.000Z'));
    expect(built).toMatchObject({ queuedMs: 10_000, wallMs: 90_000 });
  });
});

describe('matrix jobs', () => {
  test('parallel jobs keep their own bars, are ordered by start then id, and the contract holds', () => {
    const matrix = ['ubuntu', 'macos', 'windows'].map((os, index) => ({
      id: 70 + index,
      name: `test (${os})`,
      start: 10,
      end: 40 + index * 10,
    }));
    const built = buildRun(run({ id: 7 }), jobs(...matrix.reverse()), sec(300));
    expect(built.jobs.map(job => job.name)).toEqual(['test (ubuntu)', 'test (macos)', 'test (windows)']);
    expect(built.jobs.map(job => durationMs(job, sec(300)))).toEqual([30_000, 40_000, 50_000]);
    // Parallel jobs add up: the sum is longer than the wall time.
    expect(built.jobs.reduce((total, job) => total + durationMs(job, sec(300)), 0)).toBeGreaterThan(
      built.wallMs - 10_000,
    );
  });
});

describe('a skipped job', () => {
  test('has no bar and no queue time', () => {
    const built = buildRun(
      run({ id: 8 }),
      jobs({ id: 81, name: 'deploy', conclusion: 'skipped', start: 100, end: 100 }),
      sec(300),
    );
    expect(built.jobs[0]).toMatchObject({ status: 'skipped', queuedMs: 0 });
    expect(built.jobs[0]?.start).toBeUndefined();
  });
});

describe('clock skew', () => {
  test('a step outside its job is pulled inside and flagged; one that ends before it starts is flagged too', () => {
    const built = buildRun(
      run({ id: 9 }),
      jobs({
        id: 91,
        name: 'build',
        start: 10,
        end: 50,
        steps: [
          ghStep(1, { name: 'early', start: 5, end: 20 }),
          ghStep(2, { name: 'late', start: 40, end: 70 }),
          ghStep(3, { name: 'after', start: 80, end: 90 }),
          ghStep(4, { name: 'backwards', start: 30, end: 25 }),
          ghStep(5, { name: 'fine', start: 20, end: 30 }),
        ],
      }),
      sec(300),
    );
    const steps = built.jobs[0]?.steps ?? [];
    const by = (name: string) => steps.find(step => step.name === name);
    expect(by('early')).toMatchObject({
      start: at(10).replace('Z', '.000Z'),
      end: at(20).replace('Z', '.000Z'),
      clamped: true,
    });
    expect(by('late')).toMatchObject({
      start: at(40).replace('Z', '.000Z'),
      end: at(50).replace('Z', '.000Z'),
      clamped: true,
    });
    expect(by('after')).toMatchObject({
      start: at(50).replace('Z', '.000Z'),
      end: at(50).replace('Z', '.000Z'),
      clamped: true,
    });
    expect(by('backwards')).toMatchObject({
      start: at(30).replace('Z', '.000Z'),
      end: at(30).replace('Z', '.000Z'),
      clamped: true,
    });
    expect(by('fine')?.clamped).toBeUndefined();
    for (const step of steps) {
      expect(Date.parse(step.start ?? '')).toBeGreaterThanOrEqual(sec(10));
      expect(Date.parse(step.end ?? '')).toBeLessThanOrEqual(sec(50));
    }
    expect(CiRunSchema.safeParse(built).success).toBe(true);
  });
});

describe('other CI', () => {
  test('a check run is one bar with no jobs; an Actions job check is not read as one', () => {
    const check = readCheckRun(ghCheck({ id: 900, name: 'ci/circleci: build', start: 10, end: 70 }));
    if (check === undefined) throw new Error('fixture check did not parse');
    const built = buildCheckRun(check, 'a1b2c3d', sec(300));
    expect(built).toMatchObject({
      id: 900,
      status: 'passed',
      trigger: 'check',
      attempt: 1,
      queuedMs: 0,
      wallMs: 60_000,
      jobs: [],
    });
    expect(CiRunSchema.safeParse(built).success).toBe(true);
    expect(readCheckRun(ghCheck({ id: 901, name: 'build', app: 'github-actions' }))).toBeUndefined();
  });

  test('a check that is running ends at now', () => {
    const check = readCheckRun(ghCheck({ id: 902, name: 'lint', status: 'in_progress', conclusion: null, start: 10 }));
    if (check === undefined) throw new Error('fixture check did not parse');
    expect(buildCheckRun(check, 'a1b2c3d', sec(40))).toMatchObject({ status: 'running', live: true, wallMs: 30_000 });
  });
});
