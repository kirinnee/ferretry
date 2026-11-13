/**
 * This machine's Web Push, drawn: the permission and device list, the per-machine switch, and the banner that says
 * a machine reaches nobody. Both read the machine through the half's own client; the browser's side (permission, the
 * service-worker enrolment, the device memory) comes from `lib/push-host.ts`.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { daemonOfClient } from '@ferretry/app';
import { type ReactNode, useMemo } from 'react';
import { type MachineNotification, useMachineNotification } from '../../hooks/use-machine-notification.ts';
import { type MachineSource, useMachinesNotifications } from '../../hooks/use-machines-notifications.ts';
import { clientPushService } from '../../lib/push-client-service.ts';
import { browserPushHost, type PushHost } from '../../lib/push-host.ts';
import { MachineNotificationList, NotificationsOffBanner } from './notification-machines.tsx';
import { NotificationSettingsView, PushDeviceList } from './notification-settings.tsx';

/** On a machine's own screens it is just "This machine"; the device-level list names each machine. */
export const THIS_MACHINE = 'This machine';

export interface MachineNotificationsProps {
  readonly client: PluginClient;
  /** What the machine is called in the rows and the banner; "This machine" when absent. */
  readonly label?: string;
  /** The browser's push facilities; the page's own unless a suite hands one in. */
  readonly host?: PushHost;
}

function Bound({
  client,
  host,
  label,
  daemon,
  children,
}: MachineNotificationsProps & {
  readonly daemon: string;
  readonly children: (notification: MachineNotification) => ReactNode;
}) {
  const service = useMemo(() => clientPushService(client), [client]);
  const pushHost = useMemo(() => host ?? browserPushHost(), [host]);
  return <>{children(useMachineNotification({ daemon, label: label ?? THIS_MACHINE, service, host: pushHost }))}</>;
}

/** The notifications of the machine `client` talks to; nothing for a client the shell did not make. */
function ForMachine({
  client,
  host,
  label,
  children,
}: MachineNotificationsProps & { readonly children: (notification: MachineNotification) => ReactNode }) {
  const daemon = daemonOfClient(client);
  if (daemon === undefined) return null;
  return (
    <Bound
      client={client}
      {...(host === undefined ? {} : { host })}
      {...(label === undefined ? {} : { label })}
      daemon={daemon}
    >
      {children}
    </Bound>
  );
}

export interface MachinesNotificationsProps {
  /** Every machine the panel reaches, each with its OWN client (from `useEveryDaemon`). */
  readonly sources: readonly MachineSource[];
  /** The browser's push facilities; the page's own unless a suite hands one in. */
  readonly host?: PushHost;
}

/**
 * `device.settings` › notifications: the "Notifications are off" banner first (a machine with no device enrolled
 * anywhere, one Enable each), then ONE permission block (the browser's permission, its notes), then ONE list of the
 * machines this device reaches — each row a switch that enrols this browser with THAT machine through its own client,
 * its status and its registered devices — and "Turn on for all machines". A machine that wants its unlock says so and
 * offers Unlock.
 */
export function MachinesNotificationsSettings({ sources, host }: MachinesNotificationsProps) {
  const pushHost = useMemo(() => host ?? browserPushHost(), [host]);
  const notifications = useMachinesNotifications({ sources, host: pushHost });
  const unlocks = useMemo(
    () => new Map(sources.filter(source => source.locked).map(source => [source.daemon, () => void source.unlock()])),
    [sources],
  );
  return (
    <div className="flex flex-col gap-4" data-machine-notifications="">
      <NotificationsOffBanner
        rows={notifications.rows}
        canEnrol={notifications.canEnrol}
        busy={notifications.busy}
        onEnable={notifications.enable}
      />
      <NotificationSettingsView permission={notifications.permission} />
      <MachineNotificationList
        rows={notifications.rows}
        canEnrol={notifications.canEnrol}
        busy={notifications.busy}
        failures={notifications.failures}
        onEnable={notifications.enable}
        onDisable={notifications.disable}
        onTurnOnAll={notifications.turnOnAll}
        unlocks={unlocks}
        detail={row => (
          <PushDeviceList
            devices={notifications.devicesOf(row.daemonId)}
            currentDeviceId={notifications.currentDeviceId(row.daemonId)}
            onRevokeDevice={deviceId => notifications.revokeDevice(row.daemonId, deviceId)}
          />
        )}
      />
    </div>
  );
}

/** `daemon.status` › notifications-off: one line when this machine has no device enrolled anywhere. */
export function NotificationsOffPanel(props: MachineNotificationsProps) {
  return (
    <ForMachine {...props}>
      {notification => (
        <NotificationsOffBanner
          rows={notification.rows}
          canEnrol={notification.canEnrol}
          busy={notification.busy}
          onEnable={notification.enable}
        />
      )}
    </ForMachine>
  );
}
