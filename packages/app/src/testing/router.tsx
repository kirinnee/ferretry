import { type ReactNode, useMemo } from 'react';
import type { ScreenRef } from '../layout/engine.ts';
import { RouterProvider as ShellRouterProvider } from '../router/router.tsx';
import { routeTable } from '../router/routes.ts';

/**
 * A live router over the browser's own history, with only the plugin screens it is handed (none by default): it parses
 * an address through the shell's own route table, nothing more. A suite that follows an in-app link mounts its half
 * under this instead of reaching into the shell's sources; one that proves where a link lands names the screen it means.
 */
export function RouterProvider({
  children,
  screens = [],
}: {
  readonly children: ReactNode;
  readonly screens?: readonly ScreenRef[];
}) {
  const table = useMemo(() => routeTable(screens), [screens]);
  return <ShellRouterProvider parseRoute={table.parse}>{children}</ShellRouterProvider>;
}
