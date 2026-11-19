import { err, ok, type Result } from '@ferretry/std';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { type CiRun, PULLS_CODES, type RepoRef } from '../../../contract/index.ts';
import { buildCheckRun, buildRun, type ActionsJobInput } from '../../../contract/ci-timing.ts';
import { nextPagePath } from '../../adapters/github/link.ts';
import type { GithubClient, ReadFailure } from '../../adapters/github/client.ts';
import { headShaOf, listUnder, readCheckRun, readJob, readRun } from './payloads.ts';

/** Whose cache an answer is kept in, which repository, and which account reads it. */
export interface CiScope {
  readonly project: string;
  readonly account: GitAccountId;
  readonly repo: RepoRef;
}

/** The most runs one commit lists, the most job pages one run reads, and the most jobs one run keeps. */
const MAX_RUNS = 30;
const MAX_JOB_PAGES = 3;
const MAX_JOBS = 256;

const wrong = (): ReadFailure => ({ code: PULLS_CODES.github, message: 'GitHub answered with an error' });

/**
 * CI data from GitHub's Actions and checks endpoints, through the one `GithubClient` (ETag reads, one rate budget), folded
 * into `CiRun`s by `lib/ci-timing.ts`. Logs are never read (the app links to them on GitHub).
 */
export class CiReader {
  constructor(
    private readonly github: Pick<GithubClient, 'get'>,
    private readonly nowMs: () => number,
  ) {}

  /** The head commit of a pull request, or of a branch. */
  async headSha(scope: CiScope, by: { pr: number } | { branch: string }): Promise<Result<string, ReadFailure>> {
    const base = `/repos/${scope.repo.owner}/${scope.repo.name}`;
    const isPull = 'pr' in by;
    const path = isPull ? `${base}/pulls/${by.pr}` : `${base}/branches/${encodeURIComponent(by.branch)}`;
    const read = await this.github.get({ project: scope.project, account: scope.account, path });
    if (!read.ok) return read;
    const sha = headShaOf(read.value.body, isPull ? 'pull' : 'branch');
    return sha === undefined ? err(wrong()) : ok(sha);
  }

  /** Every run of a commit (GitHub Actions with their jobs and steps, then other CI as one bar each), newest first. */
  async runs(scope: CiScope, sha: string): Promise<Result<readonly CiRun[], ReadFailure>> {
    const base = `/repos/${scope.repo.owner}/${scope.repo.name}`;
    const reading = { project: scope.project, account: scope.account };
    const [listed, checks] = await Promise.all([
      this.github.get({ ...reading, path: `${base}/actions/runs?head_sha=${sha}&per_page=${MAX_RUNS}` }),
      this.github.get({ ...reading, path: `${base}/commits/${sha}/check-runs?per_page=100` }),
    ]);
    if (!listed.ok) return listed;
    if (!checks.ok) return checks;
    const runs = listUnder(listed.value.body, 'workflow_runs')
      .flatMap(raw => {
        const run = readRun(raw);
        return run === undefined ? [] : [run];
      })
      .slice(0, MAX_RUNS);
    const withJobs = await Promise.all(
      runs.map(async run => {
        const jobs = await this.#jobs(scope, `${base}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
        return jobs.ok ? ok({ run, jobs: jobs.value }) : jobs;
      }),
    );
    const now = this.nowMs();
    const built: CiRun[] = [];
    for (const item of withJobs) {
      if (!item.ok) return item;
      built.push(buildRun(item.value.run, item.value.jobs, now));
    }
    for (const raw of listUnder(checks.value.body, 'check_runs')) {
      const check = readCheckRun(raw);
      if (check !== undefined) built.push(buildCheckRun(check, sha, now));
    }
    return ok(built.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id));
  }

  /** One run with its jobs and steps: the latest attempt, or the `attempt` asked for (a re-run keeps the earlier ones). */
  async run(scope: CiScope, runId: number, attempt?: number): Promise<Result<CiRun, ReadFailure>> {
    const base = `/repos/${scope.repo.owner}/${scope.repo.name}/actions/runs/${runId}`;
    const one = attempt === undefined ? base : `${base}/attempts/${attempt}`;
    const read = await this.github.get({ project: scope.project, account: scope.account, path: one });
    if (!read.ok) return read;
    const run = readRun(read.value.body);
    if (run === undefined) return err(wrong());
    const jobsPath = attempt === undefined ? `${base}/jobs?filter=latest&per_page=100` : `${one}/jobs?per_page=100`;
    const jobs = await this.#jobs(scope, jobsPath);
    if (!jobs.ok) return jobs;
    return ok(buildRun(run, jobs.value, this.nowMs()));
  }

  /** A run's jobs, following `Link` for at most three pages (the contract keeps 256 jobs). */
  async #jobs(scope: CiScope, first: string): Promise<Result<readonly ActionsJobInput[], ReadFailure>> {
    const jobs: ActionsJobInput[] = [];
    let path: string | undefined = first;
    for (let page = 0; page < MAX_JOB_PAGES && path !== undefined; page += 1) {
      const read: Result<{ body: unknown; link?: string }, ReadFailure> = await this.github.get({
        project: scope.project,
        account: scope.account,
        path,
      });
      if (!read.ok) return read;
      for (const raw of listUnder(read.value.body, 'jobs')) {
        const job = readJob(raw);
        if (job !== undefined) jobs.push(job);
      }
      path = nextPagePath(read.value.link);
    }
    return ok(jobs.slice(0, MAX_JOBS));
  }
}
