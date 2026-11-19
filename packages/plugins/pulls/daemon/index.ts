import { milliseconds } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import manifest from '../manifest.ts';
import { GithubClient } from './adapters/github/client.ts';
import { PullsCache } from './lib/cache/store.ts';
import { pullsRoutes } from './routes.ts';

const RECONCILE_EVERY = milliseconds(10 * 60_000);

/**
 * PRs & CI (daemon half). E1 builds the GitHub client and the per-project cache and files no route. Each later unit adds
 * ONE registration line here (its routes, its watch job), importing the client built below.
 */
export default implementDaemon(manifest, {
  build: ({ needs, kernel }) => {
    const cache = new PullsCache(kernel.state, () => kernel.clock.nowMs(), kernel.log);
    // Later units read GitHub through this one client (one budget, one cache).
    const github = new GithubClient(needs.gitAccounts, cache, () => kernel.clock.nowMs(), kernel.log);

    // A removed project and a removed account take their cached private code with them, at once, on their events. The
    // sweep is the backstop for a removal this process missed (it was down), at boot and on a timer.
    const reconcile = async (): Promise<void> => {
      const [projects, accounts] = await Promise.all([needs.projects.list(), needs.gitAccounts.list()]);
      await cache.reconcile(new Set(projects.map(project => project.id)), new Set(accounts.map(account => account.id)));
    };
    kernel.jobs.add({
      id: 'cache-reconcile',
      schedule: { every: RECONCILE_EVERY },
      lane: 'worker',
      run: reconcile,
    });

    return {
      routes: pullsRoutes({
        github,
        cache,
        projects: needs.projects,
        accounts: needs.gitAccounts,
        nowMs: () => kernel.clock.nowMs(),
      }),
      subscribers: {
        'projects.removed': async payload => await cache.purgeProject((payload as { id: string }).id),
        // A reconnect of the same GitHub user reuses the id, so the old cache must be gone before it can be read again.
        'git-accounts.removed': async payload => await cache.purgeAccount((payload as { id: GitAccountId }).id),
      },
    };
  },
});
