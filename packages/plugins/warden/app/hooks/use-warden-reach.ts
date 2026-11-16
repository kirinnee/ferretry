/**
 * The Warden's reader of any paired daemon, for the view a screen or a settings tab draws: this half's own client for
 * the daemon the view is on, the Warden's row for any other, and the shell's reason when a machine has none.
 */

import { useNoReach } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useMemo, useRef } from 'react';
import type { DaemonConnection } from '../lib/machine.ts';
import type { DaemonReach, WardenClientFactory } from '../lib/warden-client-context.tsx';
import { daemonReach, wardenClientFactory } from '../lib/warden-clients.ts';
import { useWardenClients } from './use-warden-daemons.ts';

/**
 * The reach and its client factory for `connection`. A read already waiting for a machine's row sees it arrive (the live
 * ref), and a row that arrives or goes ALSO makes a new reach — so the page's polls restart and read at once, not at
 * the next tick (R2-m2): `others` changes only when a client comes or goes, never for a feed or grants answer.
 */
export function useWardenReach(
  connection: DaemonConnection,
  client: PluginClient,
): { readonly reach: DaemonReach; readonly factory: WardenClientFactory } {
  const others = useWardenClients();
  const whyNone = useNoReach();
  const live = useRef(others);
  live.current = others;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `others` is the deliberate "a row came or went" trigger
  const reach = useMemo(
    () => daemonReach(connection, client, { clients: () => live.current, whyNone }),
    [connection, client, whyNone, others],
  );
  const factory = useMemo(() => wardenClientFactory(reach), [reach]);
  return { reach, factory };
}
