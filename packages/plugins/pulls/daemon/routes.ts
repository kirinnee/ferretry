import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { GithubClient } from './adapters/github/client.ts';
import { ciRoutes } from './features/ci/index.ts';
import { threadsRoute } from './features/threads/routes.ts';
import { detailRoutes } from './features/detail/index.ts';
import type { watchFeature } from './features/watch/index.ts';
import { filesRoutes } from './features/files/index.ts';
import { type PostServices, postRoutes } from './features/post/index.ts';
import type { PullsCache } from './lib/cache/store.ts';

/** What every later unit's routes and jobs are built from: the one GitHub client (one budget) and the one cache. */
export interface PullsServices {
  readonly github: GithubClient;
  readonly cache: PullsCache;
  /** The project a route names, and the accounts that still exist. */
  readonly projects: Pick<ProjectsApi, 'find'>;
  readonly accounts: Pick<GitAccountsApi, 'list'>;
  readonly nowMs: () => number;
  /** E7: what a post needs besides the client (Gate's audit door, the exactly-once ledger). */
  readonly post: Pick<PostServices, 'record' | 'ledger' | 'log'>;
}

/** Each unit adds ONE line here, naming its routes. */
export const pullsRoutes = (services: PullsServices, watch: ReturnType<typeof watchFeature>) => ({
  ...ciRoutes(services), // E8: CI runs, jobs, steps and timing
  // E6 · review threads
  'GET /v1/pulls/:project/:repo/:number/threads': threadsRoute({
    github: services.github,
    projects: services.projects,
    nowIso: () => new Date(services.nowMs()).toISOString(),
  }),
  ...detailRoutes(services), // E4: the PR page
  ...watch.routes, // E2: the watch status and settings
  ...filesRoutes(services),
  ...postRoutes({
    ...services.post,
    github: services.github,
    projects: services.projects,
    accounts: services.accounts,
  }), // E7
});
