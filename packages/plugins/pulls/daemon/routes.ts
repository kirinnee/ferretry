import type { GithubClient } from './adapters/github/client.ts';
import type { PullsCache } from './lib/cache/store.ts';

/** What every later unit's routes and jobs are built from: the one GitHub client (one budget) and the one cache. */
export interface PullsServices {
  readonly github: GithubClient;
  readonly cache: PullsCache;
}

/** E1 files no route. Each later unit adds ONE line here, naming its routes and handing them `services`. */
export const pullsRoutes = (_services: PullsServices): [] => [];
