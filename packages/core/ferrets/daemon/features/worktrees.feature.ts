import { randomUUID } from 'node:crypto';
import { createKernelWorktreeHostIo } from '../adapters/worktrees/kernel-host-io.ts';
import { buildWorktrees } from '../modules/worktrees.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, registry, ready, late } = f;
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
    terminalRoots: async () => undefined,
    newId: () => randomUUID(),
  });
  late.worktrees = worktrees;

  return { routes: worktrees.routes };
}

export default { id: 'worktrees', register } satisfies FerretsFeature;
