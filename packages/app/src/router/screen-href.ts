import type { Views } from '../layout/engine.ts';
import type { RouteTable } from './routes.ts';
import { useOptionalShell } from '../shell/context.tsx';

/**
 * THE ADDRESS OF A PLUGIN SCREEN (replaces today's `daemonSessionPath`, `daemonQueuePath`, `daemonBoardCardPath`).
 * A half names the screen it means (`conversation`, `chat`, `{ ferret }`) and the shell's route table spells the URL,
 * so no plugin hard-codes where another plugin's screen lives. `undefined` when no installed plugin declares that
 * screen or the parameters do not fit its path.
 */
export function screenHref(
  views: Views,
  routes: RouteTable,
  daemon: string,
  plugin: string,
  screen: string,
  params: Readonly<Record<string, string>> = {},
): string | undefined {
  const ref = views.screens.get(`${plugin}.${screen}`);
  if (ref === undefined) return undefined;
  try {
    return routes.href(ref, params, daemon);
  } catch {
    return undefined;
  }
}

export type ScreenHrefOf = (
  daemon: string,
  plugin: string,
  screen: string,
  params?: Readonly<Record<string, string>>,
) => string | undefined;

const NO_SHELL: ScreenHrefOf = () => undefined;

/** `screenHref` bound to the shell this view is drawn in; outside a shell it answers `undefined`. */
export function useScreenHref(): ScreenHrefOf {
  const shell = useOptionalShell();
  if (shell === null) return NO_SHELL;
  const { views, routes } = shell;
  return (daemon, plugin, screen, params) => screenHref(views, routes, daemon, plugin, screen, params);
}
