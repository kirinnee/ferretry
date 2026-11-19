/**
 * E9's fake CI runs: the SAME GitHub-shaped fixtures E8 uses, folded by E8's own `buildRun`, so the screens are tested and
 * photographed on exactly what the daemon would send. One timeline (`T0` + seconds). Fake data only.
 */
import { buildCheckRun, buildRun } from '../../contract/ci-timing.ts';
import type { CiRun } from '../../contract/wire.ts';
import { readCheckRun, readJob, readRun } from '../../daemon/features/ci/payloads.ts';
import { T0, ghCheck, ghJob, ghRun, ghStep } from './fake-github/ci.ts';

const must = <Value>(value: Value | undefined, what: string): Value => {
  if (value === undefined) throw new Error(`fixture ${what} did not parse`);
  return value;
};
const jobsOf = (specs: readonly Parameters<typeof ghJob>[0][]) =>
  specs.map(spec => must(readJob(ghJob(spec)), `job ${spec.name}`));
const build = (run: Parameters<typeof ghRun>[0], jobs: readonly Parameters<typeof ghJob>[0][], nowSec: number): CiRun =>
  buildRun(must(readRun(ghRun(run)), `run ${run.id}`), jobsOf(jobs), T0 + nowSec * 1000);

/** The clock every scenario is read at. */
const NOW_SEC = 400;
export const NOW = T0 + NOW_SEC * 1000;

const steps = (...specs: readonly [string, number, number, ('failure' | 'skipped')?][]) =>
  specs.map(([name, start, end, outcome], index) =>
    ghStep(index + 1, {
      name,
      start: outcome === 'skipped' ? null : start,
      end: outcome === 'skipped' ? null : end,
      conclusion: outcome ?? 'success',
    }),
  );

/** A pass: three jobs, one much slower than the rest. */
export const passingRun = (): CiRun =>
  build(
    { id: 1001, name: 'CI', updated: 330 },
    [
      {
        id: 1,
        name: 'lint',
        start: 12,
        end: 52,
        steps: steps(
          ['Set up job', 12, 14],
          ['Checkout', 14, 18],
          ['Install', 18, 40],
          ['Lint', 40, 51],
          ['Post checkout', 51, 52],
        ),
      },
      {
        id: 2,
        name: 'test (ubuntu)',
        start: 14,
        end: 300,
        steps: steps(
          ['Set up job', 14, 16],
          ['Checkout', 16, 20],
          ['Install', 20, 44],
          ['Unit tests', 44, 280],
          ['Upload coverage', 280, 299],
          ['Post checkout', 299, 300],
        ),
      },
      {
        id: 3,
        name: 'build',
        start: 16,
        end: 170,
        steps: steps(['Set up job', 16, 18], ['Checkout', 18, 22], ['Compile', 22, 166], ['Upload artifact', 166, 170]),
      },
    ],
    NOW_SEC,
  );

/** A failure: the test job's third step fails and the rest of its steps are skipped. */
export const failedRun = (): CiRun =>
  build(
    {
      id: 1002,
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      attempt: 2,
      started: 130,
      created: 0,
      updated: 260,
    },
    [
      {
        id: 4,
        name: 'lint',
        start: 135,
        end: 170,
        steps: steps(['Set up job', 135, 137], ['Checkout', 137, 140], ['Lint', 140, 169]),
      },
      {
        id: 5,
        name: 'test (ubuntu)',
        conclusion: 'failure',
        start: 138,
        end: 255,
        steps: steps(
          ['Set up job', 138, 140],
          ['Install', 140, 160],
          ['Unit tests', 160, 252, 'failure'],
          ['Upload coverage', 0, 0, 'skipped'],
        ),
      },
    ],
    NOW_SEC,
  );

/** Running: one job done, one mid-step, one not started. */
export const runningRun = (): CiRun =>
  build(
    { id: 1003, name: 'CI', status: 'in_progress', conclusion: null, started: 20, updated: 380 },
    [
      { id: 7, name: 'lint', start: 22, end: 70, steps: steps(['Set up job', 22, 25], ['Lint', 25, 69]) },
      {
        id: 8,
        name: 'test (ubuntu)',
        status: 'in_progress',
        conclusion: null,
        start: 24,
        end: null,
        steps: [
          ghStep(1, { name: 'Set up job', start: 24, end: 27 }),
          ghStep(2, { name: 'Install', start: 27, end: 60 }),
          ghStep(3, { name: 'Unit tests', status: 'in_progress', conclusion: null, start: 60, end: null }),
          ghStep(4, { name: 'Upload coverage', status: 'queued', conclusion: null, start: null, end: null }),
        ],
      },
      { id: 9, name: 'deploy preview', status: 'queued', conclusion: null, start: null, end: null, steps: [] },
    ],
    NOW_SEC,
  );

/** A CI that is not GitHub Actions: one bar, no jobs. */
export const checkRun = (): CiRun =>
  buildCheckRun(
    must(readCheckRun(ghCheck({ id: 77, name: 'ci/circleci: build', start: 10, end: 190 })), 'check'),
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    NOW,
  );
