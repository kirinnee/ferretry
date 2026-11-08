import { useCallback, useSyncExternalStore } from 'react';
import { useOptionalShell } from './context.tsx';

export type { AppHookContext, AppHookProvider, AppHookProviders } from '../surfaces/app-hooks.ts';

const noSubscription = (): (() => void) => () => undefined;

/**
 * The value the one installed provider gives for `name` on `daemon`, live (it appears once the provider may run there
 * and its client exists), or `undefined`: no shell, no daemon, no provider, two providers, or a provider not allowed
 * there. The value is the provider's: the offerer narrows it before it reads it.
 */
export function useAppHook(daemon: string | undefined, name: string): unknown {
  const runtime = useOptionalShell()?.runtime;
  const read = useCallback(
    () => (runtime === undefined || daemon === undefined ? undefined : runtime.appHook(daemon, name)),
    [runtime, daemon, name],
  );
  return useSyncExternalStore(runtime?.subscribe ?? noSubscription, read, read);
}
