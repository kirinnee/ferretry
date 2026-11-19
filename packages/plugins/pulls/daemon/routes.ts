import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { GithubClient } from './adapters/github/client.ts';
import { ciRoutes } from './features/ci/index.ts';
import type { PullsCache } from './lib/cache/store.ts';

/** What every later unit's routes and jobs are built from: the one GitHub client (one budget) and the one cache. */
export interface PullsServices {
  readonly github: GithubClient;
  readonly cache: PullsCache;
  /** The project a route names, and the accounts that still exist. */
  readonly projects: Pick<ProjectsApi, 'find'>;
  readonly accounts: Pick<GitAccountsApi, 'list'>;
  readonly nowMs: () => number;
}

/** Each unit adds ONE line here, naming its routes and handing them `services`. */
export const pullsRoutes = (services: PullsServices) => ({
  ...ciRoutes(services), // E8: CI runs, jobs, steps and timing
});
