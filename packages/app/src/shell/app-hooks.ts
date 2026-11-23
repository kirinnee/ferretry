import { useCallback, useSyncExternalStore } from 'react';
import { useOptionalShell } from './context.tsx';

export type { AppHookContext, AppHookProvider, AppHookProviders } from '../surfaces/app-hooks.ts';

const noSubscription = (): (() => void) => () => undefined;

/**
 * Whether `plugin` is offered on `daemon`: false only once that machine's inventory says it is OFF (a positive word;
 * unread or unreachable is still offered, so nothing blinks away). True outside a shell and with no daemon. A page that
 * would draw a section only the plugin can serve (Projects' Board switch) leaves it out instead of saying "off".
 */
export function usePluginOffered(daemon: string | undefined, plugin: string): boolean {
  const runtime = useOptionalShell()?.runtime;
  const read = useCallback(
    () =>
      runtime === undefined ||
      daemon === undefined ||
      !runtime.surfaces.some(entry => entry.id === plugin) ||
      runtime.listedSurfaces(daemon).some(entry => entry.id === plugin),
    [runtime, daemon, plugin],
  );
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read);
}

/**
 * The value the one installed provider gives for `name` on `daemon`, live (it appears once the provider may run there
 * and its client exists), or `undefined`: no shell, no daemon, no provider, two providers, or a provider not allowed
 * there. The value is the provider's: the offerer narrows it before it reads it. With `from` (a plugin id), a hook
 * another plugin provides is none: a shared action is read only from the plugin whose name it carries.
 */
export function useAppHook(daemon: string | undefined, name: string, from?: string): unknown {
  const runtime = useOptionalShell()?.runtime;
  const read = useCallback(
    () => (runtime === undefined || daemon === undefined ? undefined : runtime.appHook(daemon, name, from)),
    [runtime, daemon, name, from],
  );
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read);
}
