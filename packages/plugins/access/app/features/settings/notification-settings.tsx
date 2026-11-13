/**
 * The browser half of Notifications: permission, the notes, and this machine's own registered-device list.
 *
 * A public PWA cannot assume that the page has notification permission, a
 * service worker, or a selected daemon. The composition host supplies those
 * facts and performs permission/subscription work only after a reader presses
 * a machine switch (`notification-machines.tsx`). This screen deliberately owns no daemon-global state.
 */
import type { PushDeviceView } from '../../../contract/index.ts';
import type { NotificationPermissionState as NotificationPermission } from '../../lib/push-host.ts';

export const NOTIFICATION_UNSUPPORTED_NOTE =
  'This browser does not expose notifications to this app. On iPhone or iPad, install the app first (Share → Add to Home Screen) and open it from the Home Screen.';
export const NOTIFICATION_DENIED_NOTE =
  'Notifications are blocked for this site in the browser. Allow them in the browser’s site settings, then come back and turn this on.';
export const NOTIFICATION_SCOPE_NOTE =
  'The live event stream is the fast path while the app is open; Web Push covers a backgrounded or closed app. Each machine owns this device’s registration with it.';
export const NOTIFICATION_IOS_NOTE =
  'On iPhone or iPad, Web Push requires iOS/iPadOS 16.4+ and this PWA installed to the Home Screen. Every browser also requires a secure HTTPS context.';

export interface NotificationSettingsViewProps {
  /** The browser capability at this instant; a host asks only from a reader's tap on a machine switch. */
  readonly permission: NotificationPermission;
  /** One machine's registered devices; every machine's switch lives in the list beside this. */
  readonly devices?: readonly PushDeviceView[];
  readonly currentDeviceId?: string | null;
  /** Absent where the devices are listed machine by machine (the device-level panel), not here. */
  readonly onRevokeDevice?: (deviceId: string) => void;
}

/**
 * Render-only browser-level view: what this browser may do, and the selected machine's registered devices.
 * The host binds its callbacks to one runtime DaemonConnection, preventing a device id from daemon A being
 * revoked on B. Turning a machine on is `notification-machines.tsx`.
 */
export interface PushDeviceListProps {
  readonly devices: readonly PushDeviceView[];
  readonly currentDeviceId: string | null;
  readonly onRevokeDevice: (deviceId: string) => void;
}

/** One machine's registered push devices, each with its own Revoke. Nothing when there are none. */
export function PushDeviceList({ devices, currentDeviceId, onRevokeDevice }: PushDeviceListProps) {
  if (devices.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" aria-label="Push devices">
      <span className="text-meta font-semibold text-muted">Registered devices</span>
      {devices.map(device => (
        <div
          key={device.id}
          className="flex min-h-[44px] items-center justify-between gap-3 rounded-control border border-border bg-surface-2 px-control-x py-1"
        >
          <span className="min-w-0 text-ui text-fg">
            {device.deviceName}
            {device.id === currentDeviceId ? <span className="text-faint"> · this device</span> : null}
          </span>
          <button
            type="button"
            className="min-h-[44px] shrink-0 rounded-control px-2 text-ui font-semibold text-warn hover:bg-warn-bg"
            onClick={() => onRevokeDevice(device.id)}
            aria-label={`Revoke push notifications for ${device.deviceName}`}
          >
            Revoke
          </button>
        </div>
      ))}
    </section>
  );
}

export function NotificationSettingsView({
  permission,
  devices = [],
  currentDeviceId = null,
  onRevokeDevice,
}: NotificationSettingsViewProps) {
  if (permission === 'unsupported') {
    return (
      <p role="status" className="m-0 text-ui leading-base text-warn">
        {NOTIFICATION_UNSUPPORTED_NOTE}
      </p>
    );
  }

  const denied = permission === 'denied';
  const status =
    permission === 'granted'
      ? 'Allowed in this browser.'
      : denied
        ? 'Blocked in this browser.'
        : 'Not asked yet — turning a machine on asks for it.';

  return (
    <section className="flex flex-col gap-2" aria-label="Notification controls">
      <p className="m-0 text-ui leading-base text-muted" data-notification-permission={permission}>
        Permission: {status}
      </p>
      {denied && (
        <p role="status" className="m-0 text-ui leading-base text-warn">
          {NOTIFICATION_DENIED_NOTE}
        </p>
      )}
      <p className="m-0 text-meta leading-base text-faint">{NOTIFICATION_SCOPE_NOTE}</p>
      <p className="m-0 text-meta leading-base text-faint">{NOTIFICATION_IOS_NOTE}</p>
      {onRevokeDevice === undefined ? null : (
        <PushDeviceList devices={devices} currentDeviceId={currentDeviceId} onRevokeDevice={onRevokeDevice} />
      )}
    </section>
  );
}
