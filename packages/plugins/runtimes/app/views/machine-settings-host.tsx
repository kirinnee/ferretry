/**
 * The host every Machines tab (Runtimes, Profiles, Model sets) sits in: it reads the machine's own view of itself
 * (`GET /v1/runtimes/machine`) through the client bound to this daemon, keeps it fresh, and hands the tab what it
 * needs. The shell mounts the tab only once the daemon is reachable and Runtimes is allowed on it, so `online` is
 * true by construction; an unreadable machine view leaves the tab to draw what it can and says so above it.
 */

import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { MachineView } from '../../contract/index.ts';
import { readMachine, changeRefusalSentence } from '../features/fleet/shell/apply-change.ts';
import type { MachineTabProps } from '../features/fleet/shell/machine-tab.ts';
import { useMachineChanges } from '../hooks/use-machine-changes.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { Button } from '../ui.ts';

type MachineRead =
  | { readonly kind: 'checking'; readonly last: MachineView | null }
  | { readonly kind: 'ready'; readonly machine: MachineView }
  | { readonly kind: 'failed'; readonly sentence: string };

/** The machine's own view of itself, read now, on retry, and again when its runtimes or default move. */
export function useMachineView(client: LiveRuntimesClient) {
  const [read, setRead] = useState<MachineRead>({ kind: 'checking', last: null });
  const generation = useRef(0);
  const reload = useCallback((): void => {
    generation.current += 1;
    const mine = generation.current;
    setRead(current => ({ kind: 'checking', last: current.kind === 'ready' ? current.machine : null }));
    readMachine(client).then(
      machine => {
        if (mine === generation.current) setRead({ kind: 'ready', machine });
      },
      error => {
        if (mine === generation.current) setRead({ kind: 'failed', sentence: changeRefusalSentence(error) });
      },
    );
  }, [client]);
  useEffect(reload, [reload]);
  useMachineChanges(client, ['runtimes'], reload);
  return { read, reload };
}

export type MachineTab = (props: MachineTabProps) => ReactNode;

/** One Settings tab: the machine read, and the tab inside it. */
export const machineSettingsView = (client: LiveRuntimesClient, Tab: MachineTab): AppComponent<SettingsProps> =>
  function MachineSettings() {
    const { read, reload } = useMachineView(client);
    const machine = read.kind === 'ready' ? read.machine : read.kind === 'checking' ? read.last : null;
    return (
      <div className="flex min-w-0 flex-col gap-4" data-machine-settings="">
        {read.kind === 'failed' ? (
          <div className="flex flex-wrap items-center gap-2" data-machine-unreadable="">
            <p role="alert" className="m-0 text-cell leading-base text-warn">
              {read.sentence}
            </p>
            <Button type="button" size="sm" data-machine-retry="" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : null}
        <Tab
          client={client}
          machineName={machine?.name ?? 'this machine'}
          machine={machine}
          online
          checking={read.kind === 'checking'}
          onRetry={reload}
          onRefresh={reload}
        />
      </div>
    );
  };
