import type { ReactNode } from 'react';
import { ShellContext, type ShellModel } from '../shell/context.tsx';

/**
 * A shell that gives app hooks and nothing else, for a suite that mounts a plugin's REAL screen or panel to prove it is
 * wired to a hook (`useAppHook`). `provided` is what the one provider of each hook name would give on any daemon; a
 * name it does not hold is a hook nobody provides (`undefined`), exactly as the shell answers one. Nothing of a real
 * shell is here beyond that: a reader of anything else finds it missing, so use it only for a view that reads hooks.
 */
export function WithAppHooks({
  provided,
  children,
}: {
  readonly provided: Readonly<Record<string, unknown>>;
  readonly children: ReactNode;
}) {
  const shell = {
    runtime: {
      appHook: (_daemon: string, name: string): unknown => provided[name],
      subscribe: () => () => undefined,
      version: () => 0,
    },
    // No plugin declares a screen here, so an address a view asks the route table for is `undefined`, as in a bare shell.
    views: { screens: new Map() },
    routes: {
      href: () => {
        throw new Error('no screen');
      },
    },
  } as unknown as ShellModel;
  return <ShellContext.Provider value={shell}>{children}</ShellContext.Provider>;
}
