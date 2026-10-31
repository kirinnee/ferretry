/**
 * "New machine setup" — a machine's setup as a FULL SCREEN of its own, outside Settings and with no app
 * chrome (the approved usability proposal; spec R4).
 *
 * Pairing a machine that is not set up opens this (`first-run-landing.ts`); pairing another phone to a
 * machine that IS set up never does. It stays revisitable: Settings › Machine › Setup opens it again
 * for a machine that is set up, with Logins as Import again, so a step skipped the first time is one
 * tap away. The steps and the rail are `machine-onboarding.tsx`.
 *
 * "Finish later" leaves at once — every step saves through its own surface as it goes — and the rail's
 * place is kept in this browser (`setup-progress.ts`), so coming back resumes there.
 */

import { type ReactNode, useCallback, useMemo, useRef } from 'react';
import type { DaemonConnectionRecord } from '../../../lib/connections.ts';
import { daemonHomePath, daemonSettingsPath } from '../../../lib/pages/routes.ts';
import { Button } from '../../../shell/primitives.tsx';
import type { ParakeetVoice } from '../../../lib/stt/parakeet-voice.ts';
import type { PairingClientFactory } from '../../settings/add-device-settings.tsx';
import { distinctDaemonName } from '../../settings/daemon-settings.tsx';
import type { FleetClientFactory } from '../fleet-client.ts';
import { machineHash } from '../shell/machine-route.ts';
import { useMachineReach } from '../shell/use-machine-reach.ts';
import { MachineOnboarding } from './machine-onboarding.tsx';
import type { VoiceCleanupPort } from './onboarding-steps.tsx';
import type { MachineSetupStepId } from './onboarding-model.ts';
import { readMachineSetupProgress, writeMachineSetupProgress } from './setup-progress.ts';

export interface MachineSetupScreenProps {
  readonly connection: DaemonConnectionRecord;
  /** Every pairing, so a machine that shares a name is told apart, and the others can be cloned from. */
  readonly connections: readonly DaemonConnectionRecord[];
  readonly createClient: FleetClientFactory;
  readonly onNavigate: (to: string) => void;
  /** Where Finish later keeps progress; `null` when this browser has no storage to keep it in. */
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** This device's dictation settings, for the Voice step's clean-up choice. */
  readonly voiceCleanup?: VoiceCleanupPort;
  /** Parakeet on this device for the Voice step; the app's own unless the harness hands one in. */
  readonly voice?: ParakeetVoice | null;
  /** The harness hands in a pairing client, so no capture ever holds a real code. */
  readonly createPairingClient?: PairingClientFactory;
  /** Open on this step rather than where progress was kept: Settings' Import again opens on Claude Code. */
  readonly startAt?: MachineSetupStepId;
}

/** A one-sentence screen for the states that are not a step: checking, unreadable. */
function SetupMessage({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
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
  voiceCleanup,
  voice,
  createPairingClient,
  startAt,
}: MachineSetupScreenProps) {
  const daemonId = connection.daemonId;
  const machineName = distinctDaemonName(connection, connections);
  const only = useMemo(() => [connection], [connection]);
  const sources = useMemo(
    () => connections.filter(candidate => candidate.daemonId !== daemonId),
    [connections, daemonId],
  );
  const reach = useMachineReach({ daemonId, connections: only, createClient });
  const shown = reach.reachOf(daemonId);
  const toMachine = useCallback(
    (): void => onNavigate(`${daemonSettingsPath(daemonId)}${machineHash(machineName, 'machine')}`),
    [daemonId, machineName, onNavigate],
  );
  const progress = useMemo(
    () =>
      storage === null
        ? undefined
        : {
            saved: readMachineSetupProgress(storage, daemonId),
            save: (next: Parameters<typeof writeMachineSetupProgress>[2]) =>
              writeMachineSetupProgress(storage, daemonId, next),
          },
    [daemonId, storage],
  );

  // ONCE THE SETUP IS ON SCREEN IT STAYS THERE. A step imports or copies, and the machine is checked
  // again right after — which answers "checking" first. That must not replace the step it came from.
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
    started.current = true;
    return (
      <MachineOnboarding
        connection={connection}
        machineName={machineName}
        machine={shown.kind === 'online' ? shown.machine : null}
        online={shown.kind !== 'offline'}
        checking={shown.kind === 'checking'}
        onRetry={() => reach.check(daemonId)}
        createClient={createClient}
        sources={sources}
        {...(progress === undefined ? {} : { progress })}
        {...(startAt === undefined ? {} : { startAt })}
        onFinish={() => onNavigate(daemonHomePath(daemonId))}
        onLeave={toMachine}
        onNavigate={onNavigate}
        {...(voiceCleanup === undefined ? {} : { voiceCleanup })}
        {...(voice === undefined ? {} : { voice })}
        {...(createPairingClient === undefined ? {} : { createPairingClient })}
      />
    );
  })();

  return (
    <main className="flex h-full min-h-0 w-full flex-col bg-bg" data-machine-setup={String(daemonId)}>
      <div className="min-h-0 flex-1">{body}</div>
    </main>
  );
}
