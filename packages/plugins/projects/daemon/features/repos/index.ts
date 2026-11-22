import type { KernelPorts, RouteHandler } from '@ferretry/kernel/contract';
import type { ProjectId } from '../../../contract/index.ts';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { kernelBrowser } from '../folders/adapter.ts';
import { accountsRoute, reposRoute } from './routes.ts';
import type { ScanDeps } from './scan.ts';

/**
 * The two routes that make a project hold many repositories and several accounts. `scan` is the one thing a test
 * replaces; the real one reads through B6's folder port and the kernel's `imports` root (no `.git/config` is read by name: it is read through the held folder).
 */
export function reposRoutes(
  kernel: Pick<KernelPorts, 'roots' | 'paths' | 'spawn'>,
  registry: ProjectRegistry,
  scan: ScanDeps = { browser: kernelBrowser(kernel) },
  listChanged?: (id: ProjectId) => void,
): Readonly<Record<'GET /v1/projects/:id/repos' | 'PUT /v1/projects/:id/accounts', RouteHandler>> {
  return {
    'GET /v1/projects/:id/repos': reposRoute(registry, scan, listChanged),
    'PUT /v1/projects/:id/accounts': accountsRoute(registry),
  };
}
