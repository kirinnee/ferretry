import type { KernelPorts, RouteHandler } from '@ferretry/kernel/contract';
import type { ProjectFolders } from '../../lib/ports.ts';
import { kernelBrowser } from './adapter.ts';
import { FolderExplorer } from './browse.ts';
import type { FolderBrowser } from './port.ts';
import { listFoldersRoute, makeFolderRoute } from './routes.ts';

export type { FolderBrowser } from './port.ts';

/**
 * The folder explorer's two routes for the project picker. `browser` is the one thing a test replaces; the real one
 * reads through the kernel's `imports` root.
 */
export function foldersRoutes(
  kernel: Pick<KernelPorts, 'roots' | 'paths'>,
  folders: Pick<ProjectFolders, 'mayName' | 'makeDirectory'>,
  browser: FolderBrowser = kernelBrowser(kernel),
): Readonly<Record<'GET /v1/projects/folders' | 'POST /v1/projects/folders', RouteHandler>> {
  const explorer = new FolderExplorer({ browser, folders });
  return {
    'GET /v1/projects/folders': listFoldersRoute(explorer),
    'POST /v1/projects/folders': makeFolderRoute(explorer),
  };
}
