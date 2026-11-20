/**
 * The host every Machines tab (Runtimes, Profiles, Model sets) sits in: it reads the machine's own view of itself
 * (`GET /v1/runtimes/machine`) through the client bound to this daemon, keeps it fresh, and hands the tab what it
 * needs. The shell mounts the tab only once the daemon is reachable and Runtimes is allowed on it, so `online` is
 * true by construction; an unreadable machine view leaves the tab to draw what it can and says so above it.
 */

import { daemonOfClient, usePairedDaemons } from '@ferretry/app';
import { type ReadPress, readPress } from '@ferretry/app/ui';
import type { StepHost } from '@ferretry/kernel/contract';
import type { AppComponent, SettingsProps } from '@ferretry/kernel/manifest';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import type { MachineView } from '../../contract/index.ts';
import { ConfigFileEditor } from '../features/fleet/profiles/config-file-editor.tsx';
import { readMachine, changeRefusalSentence } from '../features/fleet/shell/apply-change.ts';
import type { MachineTabProps } from '../features/fleet/shell/machine-tab.ts';
import { useMachineChanges } from '../hooks/use-machine-changes.ts';
import type { LiveRuntimesClient } from '../lib/client.ts';
import { Button } from '../ui.ts';
import '../features/fleet/fleet-panel.css';

type MachineRead =
  | { readonly kind: 'checking'; readonly last: MachineView | null }
  | { readonly kind: 'ready'; readonly machine: MachineView }
  | { readonly kind: 'failed'; readonly sentence: string };

/** The machine's own view of itself, read now, on retry, and again when its runtimes or default move. */
export function useMachineView(client: LiveRuntimesClient) {
  const [read, setRead] = useState<MachineRead>({ kind: 'checking', last: null });
  const generation = useRef(0);
  const load = useCallback(
    (press: ReadPress): void => {
      generation.current += 1;
      const mine = generation.current;
      setRead(current => ({ kind: 'checking', last: current.kind === 'ready' ? current.machine : null }));
      readMachine(client, press).then(
        machine => {
          if (mine === generation.current) setRead({ kind: 'ready', machine });
        },
        error => {
          if (mine === generation.current) setRead({ kind: 'failed', sentence: changeRefusalSentence(error) });
        },
      );
    },
    [client],
  );
  const reload = useCallback((): void => load({}), [load]);
  // The Try again button: reads again as the person's own press, so the passkey prompt can open.
  const press = useCallback((): void => load(readPress(true)), [load]);
  useEffect(reload, [reload]);
  useMachineChanges(client, ['runtimes'], reload);
  return { read, reload, press };
}

export type MachineTab = (props: MachineTabProps) => ReactNode;

/**
 * The name this machine goes by on screen: the paired record's live name (what the shell's list holds, updated by a rename and by
 * every plugin-list read), else the name this view last read, else "this machine". A machine named while its setup stays open
 * therefore never keeps reading "No runtimes on <host name>".
 */
export const machineNameShown = (
  paired: readonly { readonly daemon: string; readonly machine: string }[],
  daemon: string | undefined,
  read: string | undefined,
): string => {
  const live = paired.find(candidate => candidate.daemon === daemon)?.machine;
  if (live !== undefined && live !== '') return live;
  return read !== undefined && read !== '' ? read : 'this machine';
};

/** One Settings tab: the machine read, and the tab inside it. */
export const machineSettingsView = (
  client: LiveRuntimesClient,
  Tab: MachineTab,
): AppComponent<SettingsProps & { readonly step?: StepHost }> =>
  function MachineSettings({ step }: { readonly step?: StepHost }) {
    const { read, reload, press } = useMachineView(client);
    const machine = read.kind === 'ready' ? read.machine : read.kind === 'checking' ? read.last : null;
    // The name follows the machine's LIVE name (the paired record every rename and every plugin-list read updates), not the
    // name this view last read: a machine renamed while its setup is open must not keep reading "No runtimes on <old name>".
    const paired = usePairedDaemons();
    return (
      <div className="fy-fleet flex min-w-0 flex-col gap-4" data-machine-settings="">
        {read.kind === 'failed' ? (
          <div className="flex flex-wrap items-center gap-2" data-machine-unreadable="">
            <p role="alert" className="m-0 text-cell leading-base text-warn">
              {read.sentence}
            </p>
            <Button type="button" size="sm" data-machine-retry="" onClick={press}>
              Try again
            </Button>
          </div>
        ) : null}
        <Tab
          client={client}
          machineName={machineNameShown(paired, daemonOfClient(client), machine?.name)}
          machine={machine}
          online
          checking={read.kind === 'checking'}
          onRetry={reload}
          onRefresh={reload}
          {...(step === undefined ? {} : { step })}
          // Edit as YAML over the kernel's `/v1/config/file` (D2 #3).
          renderFileEditor={editor => <ConfigFileEditor client={client} {...editor} />}
        />
      </div>
    );
  };
