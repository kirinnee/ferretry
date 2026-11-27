import { mkdir } from 'node:fs/promises';
import { isWithinDirectory } from '../../../daemon/lib/worktrees/policy.ts';
import path from 'node:path';
import should from 'should';
import { ApiError } from '@ferretry/kernel/contract';
import { fixedClock, MemoryStateFolder } from '@ferretry/kernel/testing';
import { type ProjectRepository, WorktreesFile } from '../../../contract/index.ts';
import { buildWorktrees } from '../../../daemon/modules/worktrees.ts';
import type { WorktreeSessionFact } from '../../../daemon/lib/worktrees/service.ts';
import type { WorktreeRouteKey } from '../../../daemon/lib/runtime/mounts/worktrees.ts';
import type { FencedPath, FerretId, SpawnBytesOptions } from '@ferretry/kernel/contract';
import { bunSpawn } from '../../../../kernel/host/adapters/process.ts';
import { PinRegistry } from '../../../../kernel/host/pins.ts';
import { platformRootPinner } from '../../../../kernel/host/adapters/pinned/index.ts';
import { nodeFs } from '../../../../kernel/host/adapters/node-fs.ts';
import { ensureWorktreesBase, rootsPortFor } from '../../../../kernel/host/roots.ts';
import { createKernelWorktreeHostIo } from '../../../daemon/adapters/worktrees/kernel-host-io.ts';
import { tempDirectory, tempRepository } from '../../integration/daemon/support/repository.ts';

/**
 * The managed-worktree module's host IO over the kernel's REAL roots (the `worktrees` root and the ferret's `work`
 * root) on a real disk and real Git: one throwaway repository a ferret stands in, and a managed folder beside a home.
 * Shared by the host-IO integration test and the route tests that need a checkout made and removed for real.
 */

const WORLD_FERRET = 'F1' as FerretId;

/** `kernel.spawn.runBytes` for Git over a real child: a fenced folder by string, a pin by its install. */
const pins = new PinRegistry(() => platformRootPinner());
const processes = bunSpawn({ PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' });

const spawn = {
  runBytes: async (program: string, args: readonly string[], options: SpawnBytesOptions) => {
    const cwd = options.cwd;
    const alias = typeof cwd === 'object' ? pins.lookup('ferrets', cwd as never)?.alias : undefined;
    return await processes.runBytes(program, args, {
      ...options,
      cwd: alias === undefined ? cwd : (alias as FencedPath),
    });
  },
};

/** `ferret: false` stands NO ferret in the repository: the daemon has nothing but its project registry to reach it by. */
export interface WorktreeWorldOptions {
  readonly ferret?: boolean;
}

export async function composeWorktreeWorld(label: string, options: WorktreeWorldOptions = {}) {
  const parent = await tempDirectory(`${label}-home`);
  const repository = await tempRepository(`${label}-repo`);
  const folders = {
    folderOf: () => repository.root as FencedPath,
    check: (_ferret: FerretId, candidate: string) =>
      candidate.startsWith(repository.root)
        ? ({ ok: true, value: candidate as FencedPath } as const)
        : ({ ok: false, error: 'outside' } as const),
  };
  await mkdir(path.join(parent, 'home', 'state'), { recursive: true });
  const layout = { home: path.join(parent, 'home'), plugin: 'ferrets', worktrees: path.join(parent, 'home-worktrees') };
  // The host makes the managed folder before the plugin is built.
  should(
    await ensureWorktreesBase(
      nodeFs(() => 'x'),
      layout,
      ['worktrees'],
    ),
  ).be.undefined();
  const roots = rootsPortFor(
    nodeFs(() => 'x'),
    layout,
    ['worktrees', 'work', 'imports'],
    () => folders,
    { pins },
  );
  const inputs = {
    worktrees: roots.root('worktrees'),
    work: (ferret: FerretId) => roots.root('work', { ferret }),
    ferrets: () => (options.ferret === false ? [] : [{ id: WORLD_FERRET, folder: repository.root }]),
    spawn,
  };
  const io = createKernelWorktreeHostIo(inputs);
  const ioFor = (registered: readonly string[]) =>
    createKernelWorktreeHostIo({
      ...inputs,
      registered: { folders: registered, root: folder => roots.root('imports', { subfolder: folder }) },
    });
  return { parent, repository, io, ioFor };
}

/**
 * The four managed-worktree HANDLERS as Ferrets builds them (`buildWorktrees`, over the real roots and real Git above),
 * called with a request the way the router would: the handler, the schema it parses the body with, the service and the
 * registry are the real ones; the HTTP router and the admission in front of them are not in this world.
 */
export async function worktreeRouteWorld(
  label: string,
  terminalRoots: () => Promise<readonly string[] | undefined> = async () => [],
  withTerminalRemoval?: <T>(path: string, remove: () => Promise<T>) => Promise<T>,
  options: WorktreeWorldOptions & {
    /** The daemon's project registry, by id (the real one is Projects'). */
    readonly projects?: ReadonlyMap<string, ProjectRepository>;
    readonly sessions?: () => Promise<readonly WorktreeSessionFact[] | undefined>;
    readonly withFerretMove?: <T>(path: string, move: () => Promise<T>) => Promise<T>;
  } = {},
) {
  const world = await composeWorktreeWorld(label, options);
  if (world.io === undefined) throw new Error('the worktrees root named no folder');
  const hostIo = world.io;
  const state = new MemoryStateFolder();
  const clock = fixedClock('2026-11-16T00:00:00.000Z');
  let nextId = 0;
  const built = buildWorktrees({
    state: state.port([WorktreesFile]),
    clock,
    stateHomeHolding: async folder =>
      isWithinDirectory(path.join(world.parent, 'home'), folder) ? path.join(world.parent, 'home') : undefined,
    io: hostIo,
    ioFor: folders => {
      const scoped = world.ioFor(folders);
      return scoped === undefined ? undefined : { ...scoped, git: hostIo.git };
    },
    projectRepository: async project => options.projects?.get(project),
    sessions: options.sessions ?? (async () => []),
    terminalRoots,
    withFerretMove: options.withFerretMove,
    ...(withTerminalRemoval === undefined ? {} : { withTerminalRemoval }),
    newId: () => `ownership-token-${++nextId}`,
  });
  const call = async (
    key: WorktreeRouteKey,
    input: { readonly query?: Readonly<Record<string, string>>; readonly body?: unknown } = {},
  ): Promise<{ readonly status: number; readonly headers: ReadonlyMap<string, string>; readonly json: unknown }> => {
    const [method, path] = key.split(' ') as [string, string];
    const request = {
      method,
      path,
      query: new Map(Object.entries(input.query ?? {}).map(([name, value]) => [name, [value]])),
      headers: new Map<string, string>(),
      arrival: { kind: 'local' },
      text: async () => JSON.stringify(input.body ?? {}),
    };
    // The router turns a thrown ApiError into its status and { error, code }; so does this.
    try {
      const response = await built.routes[key]({ request } as never);
      return { status: response.status, headers: response.headers, json: JSON.parse(response.body) as unknown };
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { status: error.status, headers: new Map(), json: { error: error.message, code: error.code } };
    }
  };
  return { ...world, io: world.io, call, state, built, clock };
}
