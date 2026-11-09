/**
 * This machine's Web Push, drawn: the permission and device list, the per-machine switch, and the banner that says
 * a machine reaches nobody. Both read the machine through the half's own client; the browser's side (permission, the
 * service-worker enrolment, the device memory) comes from `lib/push-host.ts`.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { daemonOfClient } from '@ferretry/app';
import { type ReactNode, useMemo } from 'react';
import { type MachineNotification, useMachineNotification } from '../../hooks/use-machine-notification.ts';
import { clientPushService } from '../../lib/push-client-service.ts';
import { browserPushHost, type PushHost } from '../../lib/push-host.ts';
import { MachineNotificationList, NotificationsOffBanner } from './notification-machines.tsx';
import { NotificationSettingsView } from './notification-settings.tsx';

/** On a machine's own screens it is just "This machine"; the device-level list names each machine (`label`). */
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

/** `device.settings` › notifications: the permission, this machine's switch, and its registered devices. */
export function MachineNotificationsSettings(props: MachineNotificationsProps) {
  return (
    <ForMachine {...props}>
      {notification => (
        <div className="flex flex-col gap-4" data-machine-notifications="">
          <NotificationSettingsView
            permission={notification.permission}
            devices={notification.devices}
            currentDeviceId={notification.currentDeviceId}
            onRevokeDevice={notification.revokeDevice}
          />
          <MachineNotificationList
            rows={notification.rows}
            canEnrol={notification.canEnrol}
            busy={notification.busy}
            failures={notification.failures}
            onEnable={notification.enable}
            onDisable={notification.disable}
          />
        </div>
      )}
    </ForMachine>
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
