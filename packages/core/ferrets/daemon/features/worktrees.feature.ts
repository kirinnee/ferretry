import { randomUUID } from 'node:crypto';
import { createKernelWorktreeHostIo } from '../adapters/worktrees/kernel-host-io.ts';
import { liveTerminalRoots, withTerminalRemoval } from '../lib/worktrees/terminal-roots.ts';
import { refuse } from '../lib/runtime/mounts/worktrees.ts';
import { buildWorktrees } from '../modules/worktrees.ts';
import { TerminalRoots } from '../../contract/index.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, ready, late } = f;
  // Managed worktrees (today's worktrees module). Its Git and disk IO is the kernel's roots and spawn: the `worktrees` root
  // (`<home>-worktrees`) is the managed folder, and a repository a checkout is made from is reached through the `work`
  // root of the ferret standing in it. A host whose `worktrees` root names no folder hosts none, and every route says so.
  const worktreeIo = createKernelWorktreeHostIo({
    worktrees: kernel.roots.root('worktrees'),
    work: ferret => kernel.roots.root('work', { ferret }),
    ferrets: () => registry.list().map(ferret => ({ id: ferret.id, folder: ferret.folder })),
    spawn: kernel.spawn,
  });
  const worktrees = buildWorktrees({
    ...(worktreeIo === undefined ? {} : { io: worktreeIo }),
    state: kernel.state,
    clock: kernel.clock,
    stateHomeHolding: async folder => await kernel.paths.stateHomeHolding(folder),
    sessions: async () => {
      await ready();
      // A ferret standing in a folder, as today's session directory reported it: stopped ferrets are finished.
      return registry.list().map(ferret => ({
        id: ferret.id,
        cwd: ferret.folder,
        status: ferret.state === 'stopped' ? ('stopped' as const) : ('running' as const),
        ...(ferret.state === 'stopped' ? { finishedAt: ferret.stateAt } : {}),
      }));
    },
    terminalRoots: async () => await liveTerminalRoots(hooks.contributions(TerminalRoots).map(entry => entry.item)),
    withTerminalRemoval: async (path, remove) =>
      await withTerminalRemoval(
        hooks.contributions(TerminalRoots).map(entry => entry.item),
        path,
        remove,
      ),
    newId: () => randomUUID(),
  });
  late.worktrees = worktrees;

  // The repository listing is also a read other plugins make (Projects' worktrees section): the same refusals, as ApiErrors.
  return {
    routes: worktrees.routes,
    port: { repoWorktrees: async commonDir => await worktrees.listRepo(commonDir).catch(refuse) },
  };
}

export default { id: 'worktrees', register } satisfies FerretsFeature;
