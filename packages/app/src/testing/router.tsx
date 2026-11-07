import type { ReactNode } from 'react';
import { RouterProvider as ShellRouterProvider } from '../router/router.tsx';
import { routeTable } from '../router/routes.ts';

const table = routeTable([]);

/**
 * A live router over the browser's own history, with no plugin screens: it parses an address, nothing more. A suite
 * that follows an in-app link mounts its half under this instead of reaching into the shell's sources.
 */
export function RouterProvider({ children }: { readonly children: ReactNode }) {
  return <ShellRouterProvider parseRoute={table.parse}>{children}</ShellRouterProvider>;
}
