import { useCallback, useSyncExternalStore } from 'react';
import type { ShellPluginClient } from '../client/daemon-client.ts';
import type { PairedDaemon } from '../daemons/daemon-list.ts';
import { useOptionalShell } from './context.tsx';
import type { ShellRuntime } from './runtime.ts';

/**
 * WHAT A PLUGIN HALF MAY KNOW OF THE OTHER DAEMONS THIS BROWSER IS PAIRED WITH (§5.1, §9.6). A half is built once per
 * (daemon, package) and handed that daemon's client; a page that reads several daemons (the Warden page) needs the
 * list of them and the same package's client on each. Both come from the shell, which owns the pairings and the
 * guard: a client it hands out is bound to its daemon and its session, and refuses to send when the package is not
 * allowed there, so nothing read from one daemon is ever drawn or acted on through another.
 */

const NONE: readonly PairedDaemon[] = [];
const noSubscription = (): (() => void) => () => {};

/** Every paired daemon, newest selection first, live; empty outside a shell (a harness, a test). */
export function usePairedDaemons(): readonly PairedDaemon[] {
  const runtime = useOptionalShell()?.runtime;
  const subscribe = runtime?.daemons.subscribe ?? noSubscription;
  const snapshot = useCallback(() => runtime?.daemons.snapshot().daemons ?? NONE, [runtime]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The client of one package on one paired daemon, once that daemon answers; `unreachable` and blocked ones reject. */
export type DaemonClientOf = (daemon: string) => Promise<ShellPluginClient>;

const refusal = (runtime: ShellRuntime, daemon: string, packageId: string): string =>
  runtime.blockedLine(daemon, packageId) ?? 'This device cannot reach this daemon yet.';

/** Waits for the daemon's inventory, then answers the package's client or says why there is none. */
function clientOf(runtime: ShellRuntime, daemon: string, packageId: string): Promise<ShellPluginClient> {
  return new Promise((resolve, reject) => {
    let stop = (): void => {};
    let settled = false;
    const attempt = (): void => {
      if (settled) return;
      const connection = runtime.connection(daemon);
      const standing = runtime.standing(daemon, packageId);
      const reading =
        connection.kind === 'connecting' ||
        (connection.kind === 'connected' && standing.state === 'blocked' && standing.reason === 'unread');
      if (reading) return;
      settled = true;
      stop();
      const client = runtime.client(daemon, packageId);
      if (client === undefined) reject(new Error(refusal(runtime, daemon, packageId)));
      else resolve(client);
    };
    stop = runtime.subscribe(attempt);
    attempt();
  });
}

/**
 * The reach of one package into every paired daemon: `clientOf(daemon)` answers that package's client on that daemon,
 * the same object for as long as the connection lives. Outside a shell it rejects, saying so.
 */
export function useDaemonClients(packageId: string): DaemonClientOf {
  const runtime = useOptionalShell()?.runtime;
  return useCallback(
    daemon =>
      runtime === undefined
        ? Promise.reject(new Error('There is no app shell to reach another daemon through.'))
        : clientOf(runtime, daemon, packageId),
    [runtime, packageId],
  );
}
