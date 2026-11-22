import type { KernelPorts, RouteHandler } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { kernelBrowser } from '../folders/adapter.ts';
import { buildProjectIndex, type ProjectIndex } from './build.ts';
import { ProjectIndexCache } from './cache.ts';
import { kernelGit, kernelPins, placeOf } from './pins.ts';
import { FilesRefresh } from './refresh.ts';
import { type FilePlace, filesRescanRoute, filesRoute, filesStatusRoute } from './routes.ts';

/** What a test replaces: how one project folder becomes an index. The real one reads through the kernel's `imports` root. */
export interface FileIndexDeps {
  readonly build: (path: string, holdSlot: (work: Promise<unknown>) => void) => Promise<ProjectIndex>;
  /** Where a registered path really is (its home, what it resolves to); a test with no disk names its own. The real one asks the kernel. */
  readonly place?: FilePlace;
}

/**
 * The three routes of a project's file finder (&F6061 U5), over one in-memory cache per daemon, and the `refresh` that
 * marks that cache out of date (&F6061 U6). `folderOf` says where a ferret works (none: no early refresh).
 */
export function filesRoutes(
  kernel: Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
  registry: ProjectRegistry,
  deps?: FileIndexDeps,
  folderOf: (ferret: string) => Promise<string | undefined> = async () => undefined,
): {
  readonly routes: Readonly<
    Record<
      'GET /v1/projects/:id/files' | 'GET /v1/projects/:id/files/status' | 'POST /v1/projects/:id/files/rescan',
      RouteHandler
    >
  >;
  readonly refresh: FilesRefresh;
} {
  const build =
    deps?.build ??
    ((path: string, holdSlot: (work: Promise<unknown>) => void) =>
      buildProjectIndex(path, {
        holdSlot,
        pins: kernelPins(kernel, kernelBrowser(kernel)),
        git: kernelGit(kernel),
        nowMs: () => kernel.clock.nowMs(),
        instant: () => new Date(kernel.clock.nowMs()).toISOString() as Instant,
      }));
  const cache = new ProjectIndexCache(build, () => kernel.clock.nowMs());
  const place = deps?.place ?? placeOf(kernelBrowser(kernel));
  return {
    routes: {
      'GET /v1/projects/:id/files': filesRoute(registry, cache, place),
      'GET /v1/projects/:id/files/status': filesStatusRoute(registry, cache, place),
      'POST /v1/projects/:id/files/rescan': filesRescanRoute(registry, cache, place),
    },
    refresh: new FilesRefresh(cache, {
      projects: () => registry.list(),
      folderOf,
      resolve: path => place.resolve(path),
    }),
  };
}
