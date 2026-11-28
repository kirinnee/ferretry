import { randomUUID } from 'node:crypto';
import type { FerretId } from '@ferretry/kernel/contract';
import { createKernelWorktreeHostIo } from '../adapters/worktrees/kernel-host-io.ts';
import { liveTerminalRoots, withTerminalRemoval } from '../lib/worktrees/terminal-roots.ts';
import { refuse } from '../lib/runtime/mounts/worktrees.ts';
import { buildWorktrees } from '../modules/worktrees.ts';
import {
  GuardedWorktreeRemovalRequestSchema,
  LAUNCH_ROOTS_KEY,
  LaunchRoots,
  TerminalRoots,
  type FerretsApi,
} from '../../contract/index.ts';
import type { FeatureContribution, FerretsContext, FerretsFeature } from './types.ts';

function register(f: FerretsContext): FeatureContribution | undefined {
  const { kernel, hooks, registry, ready, late } = f;
  // Managed worktrees (today's worktrees module). Its Git and disk IO is the kernel's roots and spawn: the `worktrees` root
  // (`<home>-worktrees`) is the managed folder, and a repository a checkout is made from is reached through the `work`
  // root of the ferret standing in it. A host whose `worktrees` root names no folder hosts none, and every route says so.
  const hostInputs = {
    worktrees: kernel.roots.root('worktrees'),
    work: (ferret: FerretId) => kernel.roots.root('work', { ferret }),
    ferrets: () => registry.list().map(ferret => ({ id: ferret.id, folder: ferret.folder })),
    spawn: kernel.spawn,
  };
  const worktreeIo = createKernelWorktreeHostIo(hostInputs);
  const worktrees = buildWorktrees({
    ...(worktreeIo === undefined ? {} : { io: worktreeIo }),
    // A listing asked about a registered project may also read the folders its record names (read-only, `imports`).
    ioFor: folders =>
      createKernelWorktreeHostIo({
        ...hostInputs,
        registered: { folders, root: folder => kernel.roots.root('imports', { subfolder: folder }) },
      }),
    // The project registry is Projects'; Ferrets asks it by id through `launch.roots` and never reads a path from the caller.
    projectRepository: async (project, commonDirectory) => {
      const found = hooks.provider(LaunchRoots, LAUNCH_ROOTS_KEY);
      return found === 'unavailable' ? undefined : await found.repository?.(project, commonDirectory);
    },
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
    withFerretMove: async (path, move) => {
      f.relocations.assertFolder(path, true);
      return await f.service.withWorktreeMove(path, move);
    },
    withTerminalRemoval: async (path, remove) => {
      f.relocations.assertFolder(path, true);
      return await withTerminalRemoval(
        hooks.contributions(TerminalRoots).map(entry => entry.item),
        path,
        remove,
      );
    },
    newId: () => randomUUID(),
  });
  late.worktrees = worktrees;

  // The repository listing is also a read other plugins make (Projects' worktrees section): the same refusals, as ApiErrors.
  return {
    routes: worktrees.routes,
    port: {
      repoWorktrees: async commonDir => await worktrees.listRepo(commonDir).catch(refuse),
      checkWorktreeRemoval: async (path, cwd) => await worktrees.service.checkRemoval(path, cwd, true).catch(refuse),
      removeWorktree: async request =>
        await worktrees.service
          .remove({
            ...GuardedWorktreeRemovalRequestSchema.parse(request),
            overrides: [],
            deleteBranch: true,
            confirmations: ['delete_preexisting_branch', 'delete_unmerged_branch'],
          })
          .catch(refuse),
    },
  };
}

/** Only Tidy may apply its configure-gated, exact-head merged-worktree decision. */
export function worktreePortFor(needer: string, port: Partial<FerretsApi>): Partial<FerretsApi> {
  const { removeWorktree, ...reads } = port;
  return needer === 'tidy' && removeWorktree !== undefined ? { ...reads, removeWorktree } : reads;
}

export default { id: 'worktrees', register } satisfies FerretsFeature;
