/**
 * Lessons' own world on a real disk, for the tests of its adapters: the kernel's REAL state port over a temp home
 * (`state/lessons/`), the kernel's REAL `work` root over each ferret's real folder, and Ferrets as its contract fake.
 * Nothing here reads a real home; every folder is one this test made, and `dispose` removes them all.
 */
import { err, ok } from '@ferretry/std';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import type { FencedPath, KernelPorts, RootsPort, WorkFolders } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
import { LESSONS_STATE } from '../../../contract/index.ts';
import { StateLessonsStore } from '../../../daemon/adapters/state-store.ts';
import { AT } from '../../unit/support.ts';

export interface DiskWorld {
  readonly parent: string;
  readonly home: string;
  /** `<home>/state/lessons`, where the store's files are. */
  readonly stateFolder: string;
  readonly ferrets: FakeFerrets;
  readonly roots: Pick<RootsPort, 'root'>;
  readonly store: StateLessonsStore;
  readonly kernel: Pick<KernelPorts, 'state' | 'clock'>;
  /** A real folder under the world, made. */
  folder(...segments: string[]): Promise<string>;
  /** A ferret in Ferrets whose `work` root reaches `folder`. */
  ferret(id: string, folder: string, extra?: Partial<FerretSummary>): FerretSummary;
  /** A folder a ferret Ferrets will start later will work in: its `work` root reaches `folder` once it exists. */
  holds(id: string, folder: string): void;
  dispose(): Promise<void>;
}

/** One world; call `dispose` in `afterEach`. */
export async function diskWorld(): Promise<DiskWorld> {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-lessons-`));
  const home = `${parent}/home`;
  const stateFolder = `${home}/state/lessons`;
  await mkdir(stateFolder, { recursive: true, mode: 0o700 });
  const kernel = {
    state: state.createStatePort({ home, pluginId: 'lessons', files: LESSONS_STATE, fs: state.createNodeHostFs() }),
    clock: { now: () => AT },
  } as unknown as Pick<KernelPorts, 'state' | 'clock'>;
  const held = new Map<string, string>();
  const folders: WorkFolders = {
    folderOf: ferret => held.get(ferret) as FencedPath | undefined,
    check: (ferret, path) => {
      const folder = held.get(ferret);
      return folder !== undefined && (path === folder || path.startsWith(`${folder}/`))
        ? ok(path as FencedPath)
        : err('outside');
    },
  };
  let counter = 0;
  const roots = rootsPortFor(
    nodeFs(() => 'x'),
    { home, plugin: 'lessons', worktrees: `${parent}/worktrees` },
    ['work'],
    () => folders,
    {
      random: () => {
        counter += 1;
        return `t${String(counter)}`;
      },
    },
  );
  const ferrets = new FakeFerrets();
  return {
    parent,
    home,
    stateFolder,
    ferrets,
    roots,
    store: new StateLessonsStore(kernel),
    kernel,
    folder: async (...segments) => {
      const path = [parent, 'work', ...segments].join('/');
      await mkdir(path, { recursive: true });
      return path;
    },
    ferret: (id, folder, extra = {}) => {
      held.set(id, folder);
      return ferrets.add({ id: ferretId(id), folder, ...extra });
    },
    holds: (id, folder) => {
      held.set(id, folder);
    },
    dispose: async () => {
      await rm(parent, { recursive: true, force: true });
    },
  };
}
