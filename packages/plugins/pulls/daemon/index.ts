import { milliseconds } from '@ferretry/std';
import { implementDaemon } from '@ferretry/kernel/manifest';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { PullsChanged, PullsConfigDef } from '../contract/index.ts';
import manifest from '../manifest.ts';
import { GithubClient } from './adapters/github/client.ts';
import { configDoorOf } from './features/watch/config-door.ts';
import { watchFeature } from './features/watch/index.ts';
import { branchPullsPort } from './features/branches/index.ts';
import { newPostLedger } from './features/post/index.ts';
import { PullsCache } from './lib/cache/store.ts';
import { WatchStore } from './features/watch/store.ts';
import { pullsRoutes } from './routes.ts';

const RECONCILE_EVERY = milliseconds(10 * 60_000);

/**
 * PRs & CI (daemon half). E1 builds the GitHub client and the per-project cache and files no route. Each later unit adds
 * ONE registration line here (its routes, its watch job), importing the client built below.
 */
export default implementDaemon(manifest, {
  build: ({ needs, uses, kernel }) => {
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

    // E2: the watch of each project's PRs and CI. Its pushes go through Access when Access is there.
    const watch = watchFeature({
      github,
      store: new WatchStore(kernel.state, kernel.log),
      projects: async () => await needs.projects.list(),
      accounts: async () => await needs.gitAccounts.list(),
      config: () => kernel.config.file(PullsConfigDef),
      buzz: () => {
        const access = uses.access.current();
        return access === undefined ? undefined : async buzz => await access.buzz(buzz);
      },
      changed: project => kernel.events.publish(PullsChanged, { project }),
      nowMs: () => kernel.clock.nowMs(),
      random: () => Math.random(),
      log: kernel.log,
      jobs: kernel.jobs,
      door: configDoorOf(kernel.config),
    });

    return {
      // G3 U5: Tidy asks which PR each worktree branch had.
      provides: { pulls: branchPullsPort({ github, projects: needs.projects, nowMs: () => kernel.clock.nowMs() }) },
      routes: pullsRoutes(
        {
          github,
          cache,
          projects: needs.projects,
          accounts: needs.gitAccounts,
          nowMs: () => kernel.clock.nowMs(),
          // E7: a post is recorded through Gate, or it is not made.
          post: {
            record: () => {
              const gate = uses.gate.current();
              return gate === undefined ? undefined : async draft => await gate.audit(draft);
            },
            ledger: newPostLedger(() => kernel.clock.nowMs()),
            log: kernel.log,
          },
        },
        watch,
      ),
      subscribers: {
        'projects.removed': async payload => {
          const id = (payload as { id: string }).id;
          await cache.purgeProject(id);
          await watch.service.forgetProject(id);
        },
        // A reconnect of the same GitHub user reuses the id, so the old cache must be gone before it can be read again.
        'git-accounts.removed': async payload => {
          const id = (payload as { id: GitAccountId }).id;
          await cache.purgeAccount(id);
          await watch.service.forgetAccount(id);
        },
      },
    };
  },
});
