/**
 * The shell's router, for the suites that follow an in-app link. `@ferretry/app` exports `useOptionalRouter` but not
 * its provider, so a suite that needs a live router mounts the shell's own through its source file. This is the one
 * place to change when `@ferretry/app/testing` exports one.
 */
import type { ReactNode } from 'react';
import { RouterProvider as ShellRouterProvider } from '../../../../../../app/src/router/router.tsx';
import { routeTable } from '../../../../../../app/src/router/routes.ts';

const table = routeTable([]);

/** A router over the browser's own history, with no plugin screens: it parses an address, nothing more. */
export function RouterProvider({ children }: { readonly children: ReactNode }) {
  return <ShellRouterProvider parseRoute={table.parse}>{children}</ShellRouterProvider>;
}
