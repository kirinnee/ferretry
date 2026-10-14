/**
 * "Set up ‹machine›" — a new machine's first run as a FULL SCREEN of its own, outside Settings and with
 * no app chrome (the approved usability proposal).
 *
 * Pairing a machine that is not set up opens this (`first-run-landing.ts`); pairing another phone to a
 * machine that IS set up never does. Setting a machine up is a one-time guided job, and showing it as a
 * page four levels deep in Settings, with every app menu around it, is what made it read as just more
 * settings. "Import again" later stays where it was, on the machine's Machine tab.
 *
 * "Finish later" leaves at once — nothing is imported before the last step — and the answers and the
 * step are kept in this browser (`setup-progress.ts`), so coming back resumes there; Settings shows a
 * "Finish setting up ‹machine›" banner until the machine is set up.
 */

import { useCallback, useMemo, useRef } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { daemonSessionsPath, daemonSettingsPath } from '../../../lib/pages/routes.ts';
import { Button } from '../../../shell/primitives.tsx';
import { distinctDaemonName } from '../../settings/daemon-settings.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { machineHash } from '../shell/machine-route.ts';
import { useMachineReach } from '../shell/use-machine-reach.ts';
import { MachineFirstRun } from './first-run.tsx';
import { readSetupProgress, writeSetupProgress } from './setup-progress.ts';

export interface MachineSetupScreenProps {
  readonly connection: DaemonConnectionRecord;
  /** Every pairing, so a machine that shares a name is told apart. */
  readonly connections: readonly DaemonConnectionRecord[];
  readonly createClient: FleetClientFactory;
  readonly onNavigate: (to: string) => void;
  /** Where Finish later keeps progress; `null` when this browser has no storage to keep it in. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
}

/** A one-sentence screen for the states that are not a step: checking, already set up, unreadable. */
function SetupMessage({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 items-center justify-center px-panel" data-setup-message="">
      <div className="flex w-full max-w-[32rem] flex-col gap-2" role="status">
        <h1 className="m-0 font-display text-display font-semibold tracking-display text-fg">{title}</h1>
        {detail === undefined ? null : <p className="m-0 text-cell leading-base text-muted">{detail}</p>}
        {action === undefined ? null : <div className="mt-2 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}

export function MachineSetupScreen({
  connection,
  connections,
  createClient,
  onNavigate,
  storage,
}: MachineSetupScreenProps) {
  const daemonId = connection.daemonId;
  const machineName = distinctDaemonName(connection, connections);
  const only = useMemo(() => [connection], [connection]);
  const reach = useMachineReach({ daemonId, connections: only, createClient });
  const shown = reach.reachOf(daemonId);
  const toMachine = useCallback(
    (): void => onNavigate(`${daemonSettingsPath(daemonId)}${machineHash(machineName, 'runtimes')}`),
    [daemonId, machineName, onNavigate],
  );
  const progress = useMemo(
    () =>
      storage === null
        ? undefined
        : {
            saved: readSetupProgress(storage, daemonId),
            save: (next: Parameters<typeof writeSetupProgress>[2]) => writeSetupProgress(storage, daemonId, next),
          },
    [daemonId, storage],
  );

  // ONCE THE FIRST RUN IS ON SCREEN IT STAYS THERE. Its last step imports, and the machine is checked
  // again right after — which answers "checking", then "set up". Either would replace the run with a
  // message before it can show its own Done step, so a run that has started is only ever paused.
  const started = useRef(false);
  const body = (() => {
    if (!started.current && (shown.kind === 'checking' || shown.kind === 'locked'))
      return <SetupMessage title={`Checking ${machineName}…`} />;
    if (!started.current && shown.kind === 'unreadable')
      return (
        <SetupMessage
          title={`Can’t set up ${machineName} here`}
          detail={shown.reason}
          action={
            <Button type="button" variant="primary" onClick={toMachine}>
              Open {machineName} in Settings
            </Button>
          }
        />
      );
    if (!started.current && shown.kind === 'online' && shown.machine.setUp)
      return (
        <SetupMessage
          title={`${machineName} is already set up`}
          detail="To bring in new Claude Code or Codex setup, use Import again on its Machine tab."
          action={
            <>
              <Button type="button" variant="primary" onClick={() => onNavigate(daemonSessionsPath(daemonId))}>
                Go to sessions
              </Button>
              <Button type="button" onClick={toMachine}>
                Open in Settings
              </Button>
            </>
          }
        />
      );
    started.current = true;
    return (
      <MachineFirstRun
        mode="setup"
        presentation="screen"
        connection={connection}
        machineName={machineName}
        machine={shown.kind === 'online' ? shown.machine : null}
        online={shown.kind !== 'offline'}
        checking={shown.kind === 'checking'}
        onRetry={() => reach.check(daemonId)}
        createClient={createClient}
        {...(progress === undefined ? {} : { progress })}
        onDone={toMachine}
        onLeave={toMachine}
      />
    );
  })();

  return (
    <main className="flex h-full min-h-0 w-full flex-col bg-bg" data-machine-setup={String(daemonId)}>
      <div className="min-h-0 flex-1">{body}</div>
    </main>
  );
}
