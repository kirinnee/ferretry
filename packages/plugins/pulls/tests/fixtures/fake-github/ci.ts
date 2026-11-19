/**
 * E8's part of the fake GitHub: Actions runs, jobs, steps and check runs in the shapes `api.github.com` answers, on one
 * timeline (`T0` + seconds) so a test reads "step ran 20 s" from the numbers. Fake data only.
 */
import type { FakeGithub } from './server.ts';

export const T0 = Date.parse('2026-11-19T09:00:00Z');
export const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
/** GitHub's text for the instant `sec` seconds after `T0`. */
export const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString().replace('.000Z', 'Z');

type Time = number | null;
const time = (sec: Time): string | null => (sec === null ? null : at(sec));

export interface StepSpec {
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly start?: Time;
  readonly end?: Time;
}
export const ghStep = (number: number, spec: StepSpec) => ({
  name: spec.name,
  number,
  status: spec.status ?? 'completed',
  conclusion: spec.conclusion === undefined ? 'success' : spec.conclusion,
  started_at: time(spec.start ?? null),
  completed_at: time(spec.end ?? null),
});

export interface JobSpec {
  readonly id: number;
  readonly name: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly start?: Time;
  readonly end?: Time;
  readonly steps?: readonly ReturnType<typeof ghStep>[];
}
export const ghJob = (spec: JobSpec) => ({
  id: spec.id,
  name: spec.name,
  status: spec.status ?? 'completed',
  conclusion: spec.conclusion === undefined ? 'success' : spec.conclusion,
  created_at: at(0),
  started_at: time(spec.start ?? null),
  completed_at: time(spec.end ?? null),
  html_url: `https://github.com/octo/hello/actions/runs/1/job/${spec.id}`,
  steps: spec.steps ?? [],
});

export interface RunSpec {
  readonly id: number;
  readonly name?: string;
  readonly event?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly attempt?: number;
  readonly created?: number;
  readonly started?: Time;
  readonly updated?: number;
  readonly sha?: string;
}
export const ghRun = (spec: RunSpec) => ({
  id: spec.id,
  name: spec.name ?? 'CI',
  display_title: 'Fix the thing',
  event: spec.event ?? 'pull_request',
  status: spec.status ?? 'completed',
  conclusion: spec.conclusion === undefined ? 'success' : spec.conclusion,
  run_attempt: spec.attempt ?? 1,
  head_sha: spec.sha ?? SHA,
  created_at: at(spec.created ?? 0),
  run_started_at: time(spec.started === undefined ? 5 : spec.started),
  updated_at: at(spec.updated ?? 120),
  html_url: `https://github.com/octo/hello/actions/runs/${spec.id}`,
});

export interface CheckSpec {
  readonly id: number;
  readonly name: string;
  readonly app?: string;
  readonly status?: string;
  readonly conclusion?: string | null;
  readonly start?: Time;
  readonly end?: Time;
}
export const ghCheck = (spec: CheckSpec) => ({
  id: spec.id,
  name: spec.name,
  status: spec.status ?? 'completed',
  conclusion: spec.conclusion === undefined ? 'success' : spec.conclusion,
  started_at: time(spec.start ?? null),
  completed_at: time(spec.end ?? null),
  html_url: `https://ci.example.test/builds/${spec.id}`,
  app: { slug: spec.app ?? 'circleci-checks' },
});

const BASE = '/repos/octo/hello';

/** Serves the PR's head, the commit's runs and check runs, and each run's latest jobs. */
export function seedCi(
  github: FakeGithub,
  seed: {
    readonly pr?: number;
    readonly branch?: string;
    readonly runs: readonly ReturnType<typeof ghRun>[];
    readonly jobs?: Readonly<Record<number, readonly ReturnType<typeof ghJob>[]>>;
    readonly checks?: readonly ReturnType<typeof ghCheck>[];
  },
): void {
  if (seed.pr !== undefined) github.set(`${BASE}/pulls/${seed.pr}`, { number: seed.pr, head: { sha: SHA } });
  if (seed.branch !== undefined)
    github.set(`${BASE}/branches/${encodeURIComponent(seed.branch)}`, { name: seed.branch, commit: { sha: SHA } });
  github.set(`${BASE}/actions/runs?head_sha=${SHA}`, {
    total_count: seed.runs.length,
    workflow_runs: seed.runs,
  });
  github.set(`${BASE}/commits/${SHA}/check-runs`, {
    total_count: (seed.checks ?? []).length,
    check_runs: seed.checks ?? [],
  });
  for (const run of seed.runs) {
    github.set(`${BASE}/actions/runs/${run.id}`, run);
    const jobs = seed.jobs?.[run.id] ?? [];
    github.set(`${BASE}/actions/runs/${run.id}/jobs?filter=latest`, { total_count: jobs.length, jobs });
  }
}
