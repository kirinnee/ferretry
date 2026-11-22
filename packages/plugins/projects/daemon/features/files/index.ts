import type { KernelPorts, RouteHandler } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { kernelBrowser } from '../folders/adapter.ts';
import { buildProjectIndex, type ProjectIndex } from './build.ts';
import { ProjectIndexCache } from './cache.ts';
import { kernelGit, kernelPins } from './pins.ts';
import { filesRescanRoute, filesRoute, filesStatusRoute } from './routes.ts';

/** What a test replaces: how one project folder becomes an index. The real one reads through the kernel's `imports` root. */
export interface FileIndexDeps {
  readonly build: (path: string) => Promise<ProjectIndex>;
}

/**
 * The three routes of a project's file finder (&F6061 U5), over one in-memory cache per daemon.
 */
export function filesRoutes(
  kernel: Pick<KernelPorts, 'roots' | 'paths' | 'spawn' | 'clock'>,
  registry: ProjectRegistry,
  deps?: FileIndexDeps,
): Readonly<
  Record<
    'GET /v1/projects/:id/files' | 'GET /v1/projects/:id/files/status' | 'POST /v1/projects/:id/files/rescan',
    RouteHandler
  >
> {
  const build =
    deps?.build ??
    ((path: string) =>
      buildProjectIndex(path, {
        pins: kernelPins(kernel, kernelBrowser(kernel)),
        git: kernelGit(kernel),
        nowMs: () => kernel.clock.nowMs(),
        instant: () => new Date(kernel.clock.nowMs()).toISOString() as Instant,
      }));
  const cache = new ProjectIndexCache(build, () => kernel.clock.nowMs());
  return {
    'GET /v1/projects/:id/files': filesRoute(registry, cache),
    'GET /v1/projects/:id/files/status': filesStatusRoute(registry, cache),
    'POST /v1/projects/:id/files/rescan': filesRescanRoute(registry, cache),
  };
}
