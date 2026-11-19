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
