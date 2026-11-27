import { randomUUID } from 'node:crypto';
import { Harnesses, type FerretsApi } from '../../contract/index.ts';
import type { BuiltWorktrees } from '../modules/worktrees.ts';
import { ForkService, type ForkPorts, type ForkWorktrees } from '../lib/forks/fork-service.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

/** The plugin that owns the fork route and its form, so the only one that forks a ferret. */
const CONVERSATION_PLUGIN = 'conversation';

/** The managed worktrees a fork cuts a checkout from: this daemon's own host, or none while it hosts none. */
export function forkWorktrees(built: BuiltWorktrees | undefined): ForkWorktrees | undefined {
  const gateway = built?.gateway;
  if (built === undefined || gateway === undefined) return undefined;
  return {
    inspect: async folder => {
      const checkout = await gateway.inspect(folder);
      if (!checkout.repo) throw new Error(`it is ${checkout.kind === 'missing' ? 'missing' : 'not a Git repository'}`);
      if (checkout.head === undefined) throw new Error('it has no commit yet');
      return { head: checkout.head };
    },
    create: async request => {
      const made = await built.service.create({ ...request });
      return { cwd: made.cwd, worktree: { path: made.worktree.path, branch: made.worktree.branch } };
    },
    discard: async worktree => {
      // Brand new and never started in: its branch holds exactly the source's HEAD (the source keeps those commits).
      await built.service.remove({
        path: worktree.path,
        overrides: ['accept_unpushed_commits'],
        deleteBranch: true,
        confirmations: ['delete_unpushed_branch', 'delete_unmerged_branch'],
      });
    },
  };
}

/** Only Conversation forks; every other needer is handed the port without `forks`. */
export function forkPortFor(needer: string, port: Partial<FerretsApi>): Partial<FerretsApi> {
  const { forks, ...rest } = port;
  return needer === CONVERSATION_PLUGIN && forks !== undefined ? { ...rest, forks } : rest;
}

/**
 * Fork a ferret's conversation into a new ferret (`FerretsApi.forks`, c58-37 PR8): the harness cuts the conversation
 * (`Harness.fork`), Ferrets starts a new ferret on the cut. It adds no route: the fork route is Conversation's, which owns
 * the message selection, the attachments and the form, and calls this.
 */
function register(f: FerretsContext): FeatureContribution | undefined {
  const { registry, service, hooks, late } = f;
  const ports: ForkPorts = {
    source: ferret => {
      const record = registry.get(ferret);
      return record === undefined
        ? undefined
        : {
            name: record.name,
            harness: record.harness,
            ...(record.runtime === undefined ? {} : { runtime: record.runtime }),
            ...(record.login === undefined ? {} : { login: record.login }),
            folder: record.folder,
            running: record.state === 'starting' || record.state === 'working',
          };
    },
    mayTouch: (caller, target) => registry.mayTouch(caller, target),
    harness: key => {
      const found = hooks.provider(Harnesses, key);
      return found === 'unavailable' ? undefined : found;
    },
    start: async (request, origin, admission) => await service.start(request, origin, admission),
    worktrees: () => forkWorktrees(late.worktrees),
    newId: () => randomUUID(),
  };
  const forks = new ForkService(ports);
  return {
    port: { forks: { fork: async (from, at, options, caller) => await forks.fork(from, at, options, caller) } },
  };
}

export default { id: 'forks', register } satisfies FerretsFeature;
