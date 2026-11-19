/**
 * E10's fake CI runs: the SAME GitHub-shaped fixtures E8 tests with (`fake-github/ci.ts`), folded by E8's own
 * `buildRun`, so the timeline is checked against the model the daemon really serves. Fake data only; one timeline
 * (`T0` + seconds) so a test reads "this step started 12 s in" from the numbers.
 */
import { type ActionsJobInput, buildRun } from '../../contract/ci-timing.ts';
import type { CiRun } from '../../contract/index.ts';
import { readJob, readRun } from '../../daemon/features/ci/payloads.ts';
import { T0, ghJob, ghRun, ghStep } from './fake-github/ci.ts';

export const sec = (seconds: number): number => T0 + seconds * 1000;

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

/** A finished run that failed: build passes, test fails, the upload after it is skipped, lint is skipped. */
export const FINISHED: { readonly run: CiRun; readonly now: number } = {
  now: sec(400),
  run: buildRun(
    run({ id: 100, name: 'CI', created: 0, started: 6, updated: 135, conclusion: 'failure' }),
    jobs(
      {
        id: 1,
        name: 'build',
        start: 10,
        end: 70,
        steps: [
          ghStep(1, { name: 'Set up job', start: 10, end: 14 }),
          ghStep(2, { name: 'Install dependencies', start: 14, end: 40 }),
          ghStep(3, { name: 'Compile', start: 40, end: 70 }),
        ],
      },
      {
        id: 2,
        name: 'test',
        conclusion: 'failure',
        start: 72,
        end: 135,
        steps: [
          ghStep(1, { name: 'Checkout', start: 72, end: 75 }),
          ghStep(2, { name: 'Unit tests', conclusion: 'failure', start: 75, end: 130 }),
          ghStep(3, { name: 'Upload report', conclusion: 'skipped' }),
        ],
      },
      { id: 3, name: 'lint', conclusion: 'skipped' },
    ),
    sec(400),
  ),
};

/** A run in progress at `T0 + 95 s`: build is done, test is running its second step, deploy is still queued. */
export const RUNNING: { readonly run: CiRun; readonly now: number } = {
  now: sec(95),
  run: buildRun(
    run({ id: 101, name: 'CI', status: 'in_progress', conclusion: null, created: 0, started: 4 }),
    jobs(
      {
        id: 11,
        name: 'build',
        start: 8,
        end: 40,
        steps: [ghStep(1, { name: 'Compile', start: 8, end: 40 })],
      },
      {
        id: 12,
        name: 'test',
        status: 'in_progress',
        conclusion: null,
        start: 42,
        end: null,
        steps: [
          ghStep(1, { name: 'Unit tests', start: 42, end: 70 }),
          ghStep(2, { name: 'Integration tests', status: 'in_progress', conclusion: null, start: 70 }),
          ghStep(3, { name: 'Report', status: 'queued', conclusion: null }),
        ],
      },
      { id: 13, name: 'deploy', status: 'queued', conclusion: null },
    ),
    sec(95),
  ),
};

/** A matrix: six parallel jobs that start at different times (runner availability), one fails. */
export const MATRIX: { readonly run: CiRun; readonly now: number } = {
  now: sec(300),
  run: buildRun(
    run({ id: 102, name: 'Matrix', created: 0, started: 3, updated: 210, conclusion: 'failure' }),
    jobs(
      ...['ubuntu', 'macos', 'windows'].flatMap((os, osIndex) =>
        [18, 20].map((node, nodeIndex) => {
          const start = 6 + osIndex * 14 + nodeIndex * 3;
          const end = start + 70 + osIndex * 25 + nodeIndex * 8;
          const failed = os === 'windows' && node === 20;
          return {
            id: 200 + osIndex * 10 + nodeIndex,
            name: `test (${os}, node ${node})`,
            conclusion: failed ? 'failure' : 'success',
            start,
            end,
            steps: [
              ghStep(1, { name: 'Set up', start, end: start + 8 }),
              ghStep(2, { name: 'Install', start: start + 8, end: start + 30 }),
              ghStep(3, { name: 'Test', conclusion: failed ? 'failure' : 'success', start: start + 30, end }),
            ],
          };
        }),
      ),
    ),
    sec(300),
  ),
};

// ─── plain `CiRun`s for the cases E8's builder cannot make on purpose (a stale snapshot, the biggest run) ────────────

const iso = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** The biggest run the contract allows (256 jobs x 500 steps), every step a different whole number of seconds. */
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
  jobs: Array.from({ length: jobCount }, (_, jobIndex) => ({
    id: jobIndex + 1,
    name: `job ${jobIndex + 1}`,
    status: jobIndex === jobCount - 1 ? ('failed' as const) : ('passed' as const),
    queuedMs: 1_000,
    start: iso(1),
    end: iso(1 + stepCount * 3),
    steps: Array.from({ length: stepCount }, (_, stepIndex) => ({
      name: `step ${stepIndex + 1}`,
      number: stepIndex + 1,
      status: 'passed' as const,
      start: iso(1 + stepIndex * 3),
      end: iso(1 + stepIndex * 3 + 1 + ((stepIndex + jobIndex) % 2)),
    })),
  })),
});

/** A cancelled run: its job stopped 11 s in, holding a step E8 clamped to that end but still flagged live. */
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
    {
      id: 8,
      name: 'test',
      status: 'cancelled',
      queuedMs: 1_000,
      start: iso(1),
      end: iso(11),
      steps: [
        { name: 'Check out', number: 1, status: 'passed', start: iso(1), end: iso(2) },
        { name: 'Unit tests', number: 2, status: 'running', start: iso(2), end: iso(11), live: true, clamped: true },
      ],
    },
  ],
};

/** A live run read at 1 s: a live job and step, and a queued job (no bar) that has waited 1 s. Draw it later and it ticks. */
export const SNAPSHOT_RUN: CiRun = {
  id: 9007,
  name: 'CI',
  status: 'running',
  trigger: 'push',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  queuedMs: 0,
  wallMs: 1_000,
  live: true,
  jobs: [
    {
      id: 9,
      name: 'test',
      status: 'running',
      queuedMs: 0,
      start: iso(0),
      end: iso(1),
      live: true,
      steps: [{ name: 'Unit tests', number: 1, status: 'running', start: iso(0), end: iso(1), live: true }],
    },
    { id: 10, name: 'deploy', status: 'queued', queuedMs: 1_000, steps: [] },
  ],
};

/** A live run where nothing has started: the wait is the clock's, never the snapshot's. */
export const WAITING_RUN: CiRun = {
  id: 9008,
  name: 'CI',
  status: 'queued',
  trigger: 'push',
  attempt: 1,
  headSha: SHA,
  createdAt: iso(0),
  queuedMs: 1_000,
  wallMs: 1_000,
  live: true,
  jobs: [{ id: 11, name: 'build', status: 'queued', queuedMs: 1_000, steps: [] }],
};
