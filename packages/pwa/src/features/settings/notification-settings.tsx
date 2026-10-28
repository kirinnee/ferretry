/**
 * The browser half of Notifications: permission, the notes, and the selected daemon's own
 * registered-device list.
 *
 * A public PWA cannot assume that the page has notification permission, a
 * service worker, or a selected daemon. The composition host supplies those
 * facts and performs permission/subscription work only after a reader presses
 * a machine switch (`notification-machines.tsx`). This screen deliberately owns no daemon-global state.
 *
 * WHICH EVENT KINDS SHOW, AND QUIET HOURS, ARE NOT HERE. Both are decisions about this browser, made
 * once rather than once per daemon, and the daemon no longer stores or enforces a per-device
 * preference at all — see `notification-filter-settings.tsx`, rendered alongside this card.
 */
import type { PushDeviceView } from '@ferretry/protocol';

import { cn } from '../../lib/class-names.ts';

export type NotificationPermission = 'unsupported' | 'default' | 'denied' | 'granted';

export const NOTIFICATION_UNSUPPORTED_NOTE =
  'This browser does not expose notifications to this app. On iPhone or iPad, install the app first (Share → Add to Home Screen) and open it from the Home Screen.';
export const NOTIFICATION_DENIED_NOTE =
  'Notifications are blocked for this site in the browser. Allow them in the browser’s site settings, then come back and turn this on.';
export const NOTIFICATION_SCOPE_NOTE =
  'The live event stream is the fast path while the app is open; Web Push covers a backgrounded or closed app. Each machine owns this device’s registration with it.';
export const NOTIFICATION_IOS_NOTE =
  'On iPhone or iPad, Web Push requires iOS/iPadOS 16.4+ and this PWA installed to the Home Screen. Every browser also requires a secure HTTPS context.';

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
}: {
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  readonly label: string;
  readonly description: string;
  readonly disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
        checked ? 'border-accent bg-accent-soft' : 'border-border bg-surface-2 hover:border-accent',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <span className="min-w-0">
        <span className={cn('block text-ui font-semibold', checked ? 'text-accent' : 'text-fg')}>{label}</span>
        <span className="block text-meta leading-base text-muted">{description}</span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border-strong bg-surface',
        )}
      >
        <span
          className={cn(
            'absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full bg-fg transition-transform',
            checked ? 'translate-x-[18px]' : 'translate-x-[2px]',
          )}
        />
      </span>
    </button>
  );
}

export interface NotificationSettingsViewProps {
  /** The browser capability at this instant; a host asks only from a reader's tap on a machine switch. */
  readonly permission: NotificationPermission;
  /** The selected machine's own registered devices; every machine's switch lives in the list beside this. */
  readonly devices?: readonly PushDeviceView[];
  readonly currentDeviceId?: string | null;
  readonly onRevokeDevice: (deviceId: string) => void;
}

/**
 * Render-only browser-level view: what this browser may do, and the selected machine's registered devices.
 * The host binds its callbacks to one runtime DaemonConnection, preventing a device id from daemon A being
 * revoked on B. Turning a machine on is `notification-machines.tsx`.
 */
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
      {devices.length > 0 && (
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
      )}
    </section>
  );
}
