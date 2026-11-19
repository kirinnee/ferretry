/**
 * E11's fake CI runs, already folded to the `CiRun` the flamegraph draws (no network, no GitHub): one finished run whose
 * jobs ran in parallel (so the total is longer than the wall time), one still running, and one check from a CI that is
 * not GitHub Actions. Times are seconds after `T0`.
 */
import type { CiJob, CiRun, CiStatus, CiStep } from '../../contract/index.ts';

export const T0 = Date.parse('2026-11-19T09:00:00Z');
const iso = (sec: number): string => new Date(T0 + sec * 1000).toISOString();
export const secondsAfterT0 = (sec: number): number => T0 + sec * 1000;

const step = (
  number: number,
  name: string,
  status: CiStatus,
  from: number | undefined,
  to: number | undefined,
  live = false,
): CiStep => ({
  name,
  number,
  status,
  ...(from === undefined ? {} : { start: iso(from) }),
  ...(to === undefined ? {} : { end: iso(to) }),
  ...(live ? { live: true } : {}),
});

const job = (
  id: number,
  name: string,
  status: CiStatus,
  from: number | undefined,
  to: number | undefined,
  steps: CiStep[],
  live = false,
): CiJob => ({
  id,
  name,
  status,
  queuedMs: (from ?? 0) * 1000,
  ...(from === undefined ? {} : { start: iso(from) }),
  ...(to === undefined ? {} : { end: iso(to) }),
  ...(live ? { live: true } : {}),
  steps,
});

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** Finished and failed: lint, test and build ran side by side; docs was skipped. Total 400 s, wall time 262 s. */
export const FAILED_RUN: CiRun = {
  id: 9001,
  name: 'CI',
  status: 'failed',
  trigger: 'pull_request',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  start: iso(4),
  end: iso(262),
  queuedMs: 6_000,
  wallMs: 262_000,
  url: 'https://github.com/octo/hello/actions/runs/9001',
  jobs: [
    job(1, 'lint', 'passed', 6, 44, [
      step(1, 'Check out', 'passed', 6, 10),
      step(2, 'Set up bun', 'passed', 10, 19),
      step(3, 'Lint', 'passed', 19, 41),
      step(4, 'Post check out', 'passed', 41, 44),
    ]),
    job(2, 'test', 'failed', 7, 259, [
      step(1, 'Check out', 'passed', 7, 11),
      step(2, 'Set up bun', 'passed', 11, 20),
      step(3, 'Install', 'passed', 20, 61),
      step(4, 'Unit tests', 'failed', 61, 239),
      step(5, 'Post check out', 'passed', 239, 259),
    ]),
    job(3, 'build', 'passed', 8, 118, [
      step(1, 'Check out', 'passed', 8, 12),
      step(2, 'Compile', 'passed', 12, 108),
      step(3, 'Upload artifact', 'passed', 108, 118),
      step(4, 'Notify', 'skipped', undefined, undefined),
    ]),
    job(4, 'docs', 'skipped', undefined, undefined, [step(1, 'Build docs', 'skipped', undefined, undefined)]),
  ],
};

/** Still running 100 s in: one job done, one with a live step. */
export const RUNNING_RUN: CiRun = {
  id: 9002,
  name: 'CI',
  status: 'running',
  trigger: 'push',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  start: iso(3),
  queuedMs: 4_000,
  wallMs: 100_000,
  live: true,
  jobs: [
    job(5, 'lint', 'passed', 4, 30, [step(1, 'Check out', 'passed', 4, 9), step(2, 'Lint', 'passed', 9, 30)]),
    job(
      6,
      'test',
      'running',
      5,
      100,
      [
        step(1, 'Check out', 'passed', 5, 9),
        step(2, 'Install', 'passed', 9, 50),
        step(3, 'Unit tests', 'running', 50, 100, true),
      ],
      true,
    ),
  ],
};

/** A CI that is not GitHub Actions: one bar, no steps. */
export const CHECK_RUN: CiRun = {
  id: 9003,
  name: 'ci/circleci: build',
  status: 'passed',
  trigger: 'check',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  start: iso(0),
  end: iso(75),
  queuedMs: 0,
  wallMs: 75_000,
  jobs: [],
};

/** Nothing has started: queued. */
export const QUEUED_RUN: CiRun = {
  id: 9004,
  name: 'CI',
  status: 'queued',
  trigger: 'pull_request',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  queuedMs: 12_000,
  wallMs: 12_000,
  live: true,
  jobs: [job(7, 'test', 'queued', undefined, undefined, [])],
};

/** The biggest run the contract allows (256 jobs, 500 steps each), every job and step lasting a different, whole number of seconds. */
export const BIG_RUN = (jobCount = 256, stepCount = 500): CiRun => ({
  id: 9005,
  name: 'CI',
  status: 'failed',
  trigger: 'push',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  start: iso(1),
  end: iso(10_000),
  queuedMs: 1_000,
  wallMs: 10_000_000,
  jobs: Array.from({ length: jobCount }, (_, jobIndex) =>
    job(
      jobIndex + 1,
      `job ${jobIndex + 1}`,
      jobIndex === jobCount - 1 ? 'failed' : 'passed',
      1,
      1 + stepCount * 3,
      Array.from({ length: stepCount }, (_, stepIndex) =>
        step(
          stepIndex + 1,
          `step ${stepIndex + 1}`,
          'passed',
          1 + stepIndex * 3,
          1 + stepIndex * 3 + 1 + ((stepIndex + jobIndex) % 2),
        ),
      ),
    ),
  ),
});

/** A cancelled job that stopped 10 s in, holding a step E8 clamped to that end (still flagged live): 9 s long, for good. */
export const CANCELLED_RUN: CiRun = {
  id: 9006,
  name: 'CI',
  status: 'cancelled',
  trigger: 'push',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  start: iso(1),
  end: iso(11),
  queuedMs: 1_000,
  wallMs: 11_000,
  jobs: [
    job(8, 'test', 'cancelled', 1, 11, [
      step(1, 'Check out', 'passed', 1, 2),
      { ...step(2, 'Unit tests', 'running', 2, 11, true), clamped: true },
    ]),
  ],
};

/** A live run, a live job and a live step, all 1 s old at the snapshot the caller took. */
export const SNAPSHOT_RUN: CiRun = {
  id: 9007,
  name: 'CI',
  status: 'running',
  trigger: 'push',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  start: iso(0),
  queuedMs: 0,
  wallMs: 1_000,
  live: true,
  jobs: [job(9, 'test', 'running', 0, 1, [step(1, 'Unit tests', 'running', 0, 1, true)], true)],
};
