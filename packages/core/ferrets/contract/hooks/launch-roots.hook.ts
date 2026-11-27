import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/** The repository a registered project records: the project's own folder and its git COMMON directory. */
export interface ProjectRepository {
  readonly folder: string;
  readonly commonDirectory: string;
}

/** The project folders a governed device may start a ferret in without terminal access (absolute paths). */
export interface LaunchRootsSource {
  roots(): Promise<readonly string[]>;
  /**
   * The repository a REGISTERED project records, found by the project's id in the registry's own records, or none (no
   * such project, or one that is no git repository). The repository worktree list asks it so a caller names a project
   * and never a path: Ferrets reads the answer, it never takes a directory from the caller.
   */
  repository?(project: string): Promise<ProjectRepository | undefined>;
}

/** The one key `launch.roots` is provided under. */
export const LAUNCH_ROOTS_KEY = 'projects';

/**
 * Which folders count as known projects. On the security path: what it lists decides whether a governed device's start
 * is an ordinary act or terminal access (`terminal.use`), so ONE named plugin provides it. With no provider the list is
 * empty and every governed start asks for `terminal.use` (narrower, never wider); a throw is a 503.
 */
export const LaunchRoots = defineHook('launch.roots', {
  mode: 'provide',
  key: z.literal(LAUNCH_ROOTS_KEY),
  value: z.custom<LaunchRootsSource>(),
  takers: ['projects'],
});
