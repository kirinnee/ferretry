/**
 * Notification preferences, presented over explicit runtime controls.
 *
 * A public PWA cannot assume that the page has notification permission, a
 * service worker, or a selected daemon. The composition host supplies those
 * facts and performs permission/subscription work only after a reader presses
 * the master control. This screen deliberately owns no daemon-global state.
 */
import type { PushDeviceView, PushNotificationKind, PushPreferences } from '@ferretry/protocol';

import { cn } from '../../lib/class-names.ts';

export type NotificationPermission = 'unsupported' | 'default' | 'denied' | 'granted';
export type PushDeliveryState = 'idle' | 'checking' | 'active' | 'unavailable';

export const NOTIFICATION_KIND_COPY: Record<PushNotificationKind, { label: string; description: string }> = {
  attention: { label: 'Attention', description: 'A session is waiting at the prompt.' },
  question: { label: 'Questions', description: 'A session asked a structured question.' },
  failed: { label: 'Failures', description: 'A session failed, stalled, or could not be stopped.' },
  completed: { label: 'Completions', description: 'A session finished its task.' },
};

export const NOTIFICATION_UNSUPPORTED_NOTE =
  'This browser does not expose notifications to this app. On iPhone or iPad, install the app first (Share → Add to Home Screen) and open it from the Home Screen.';
export const NOTIFICATION_DENIED_NOTE =
  'Notifications are blocked for this site in the browser. Allow them in the browser’s site settings, then come back and turn this on.';
export const NOTIFICATION_SCOPE_NOTE =
  'The live event stream is the fast path while the app is open; Web Push covers a backgrounded or closed app. The selected daemon owns this device registration.';
export const NOTIFICATION_IOS_NOTE =
  'On iPhone or iPad, Web Push requires iOS/iPadOS 16.4+ and this PWA installed to the Home Screen. Every browser also requires a secure HTTPS context.';

const kinds: readonly PushNotificationKind[] = ['attention', 'question', 'failed', 'completed'];

function Toggle({
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
  /** The browser capability at this instant; a host asks only from `onEnabled`. */
  readonly permission: NotificationPermission;
  /** Reader preference after the selected daemon has accepted a device registration. */
  readonly enabled: boolean;
  readonly preferences: PushPreferences;
  readonly delivery: PushDeliveryState;
  readonly deliveryMessage?: string | null;
  readonly devices?: readonly PushDeviceView[];
  readonly currentDeviceId?: string | null;
  readonly onEnabled: (enabled: boolean) => void;
  readonly onPreferences: (preferences: PushPreferences) => void;
  readonly onRevokeDevice: (deviceId: string) => void;
}

/**
 * Render-only settings view. The host binds its callbacks to one runtime
 * DaemonConnection, preventing a device id from daemon A being revoked on B.
 */
export function NotificationSettingsView({
  permission,
  enabled,
  preferences,
  delivery,
  deliveryMessage = null,
  devices = [],
  currentDeviceId = null,
  onEnabled,
  onPreferences,
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
  const active = enabled && permission === 'granted';
  const deliveryCopy =
    delivery === 'active'
      ? 'Web Push is active for this device — closed-app delivery is ready.'
      : delivery === 'checking'
        ? 'Checking closed-app Web Push…'
        : (deliveryMessage ?? 'Web Push is not active for this device yet; the live app can still show changes.');

  return (
    <section className="flex flex-col gap-2" aria-label="Notification controls">
      <Toggle
        checked={active}
        disabled={denied}
        onChange={onEnabled}
        label="Notify me"
        description="System notification when a session needs attention. Turning this on asks the browser for permission."
      />
      {denied && (
        <p role="status" className="m-0 text-ui leading-base text-warn">
          {NOTIFICATION_DENIED_NOTE}
        </p>
      )}
      {active && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Notify about</legend>
            {kinds.map(kind => (
              <Toggle
                key={kind}
                checked={preferences.events[kind]}
                onChange={next => onPreferences({ ...preferences, events: { ...preferences.events, [kind]: next } })}
                label={NOTIFICATION_KIND_COPY[kind].label}
                description={NOTIFICATION_KIND_COPY[kind].description}
              />
            ))}
          </fieldset>
          <Toggle
            checked={preferences.interactiveOnly}
            onChange={next => onPreferences({ ...preferences, interactiveOnly: next })}
            label="Interactive sessions only"
            description="Skip auto sessions. Off means every session can notify, including auto sessions that reach a permission prompt."
          />
        </>
      )}
      <p className="m-0 text-meta leading-base text-faint">{NOTIFICATION_SCOPE_NOTE}</p>
      <p className="m-0 text-meta leading-base text-faint">{NOTIFICATION_IOS_NOTE}</p>
      {permission === 'granted' && (
        <p
          role="status"
          className={cn(
            'm-0 text-ui leading-base',
            delivery === 'active' ? 'text-ok' : delivery === 'checking' ? 'text-muted' : 'text-warn',
          )}
        >
          {deliveryCopy}
        </p>
      )}
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
