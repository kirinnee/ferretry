import type { KernelPorts, RouteHandler } from '@ferretry/kernel/contract';
import type { ProjectId } from '../../../contract/index.ts';
import type { ProjectFolders } from '../../lib/ports.ts';
import type { ProjectRegistry } from '../../lib/registry.ts';
import { kernelBrowser } from '../folders/adapter.ts';
import { accountsRoute, cloneRoute, reposRoute } from './routes.ts';
import type { ScanDeps } from './scan.ts';

/**
 * The routes that make a project hold many repositories and several accounts: the scan, the clone of another one into
 * the project, and the account links. `scan` is the one thing a test replaces; the real one reads through B6's folder port
 * and the kernel's `imports` root (no `.git/config` is read by name: it is read through the held folder).
 */
export function reposRoutes(
  kernel: Pick<KernelPorts, 'roots' | 'paths' | 'spawn'>,
  registry: ProjectRegistry,
  folders: ProjectFolders,
  scan: ScanDeps = { browser: kernelBrowser(kernel) },
  listChanged?: (id: ProjectId) => void,
): Readonly<
  Record<'GET /v1/projects/:id/repos' | 'POST /v1/projects/:id/repos' | 'PUT /v1/projects/:id/accounts', RouteHandler>
> {
  return {
    'GET /v1/projects/:id/repos': reposRoute(registry, scan, listChanged),
    'POST /v1/projects/:id/repos': cloneRoute(registry, folders, scan, listChanged),
    'PUT /v1/projects/:id/accounts': accountsRoute(registry),
  };
}
