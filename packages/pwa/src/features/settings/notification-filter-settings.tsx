/**
 * THIS DEVICE'S notification filter — the owner-approved spec's "This device" pill.
 *
 * Every paired machine now sends every event (`packages/daemon/src/lib/push/service.ts`); this
 * screen is the only place left that decides what a reader actually sees: the four switches
 * (needs you, finished, failed, new device) and quiet hours, all device-wide. Muting one machine alone is a
 * row in `notification-machines.tsx`. All of it is local to this browser; nothing here is sent to any daemon.
 */
import {
  type DeviceNotificationFilterPreferences,
  formatTimeOfDay,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_COPY,
  type NotificationCategory,
  parseTimeOfDay,
  type QuietHours,
} from '../../lib/notification-filter.ts';
import { Toggle } from './notification-settings.tsx';

export const NOTIFICATION_FILTER_SCOPE_NOTE =
  'Every paired machine sends every event now. These switches decide what this browser shows — they apply to every machine at once. Muting one machine alone is in its row above.';

export interface NotificationFilterSettingsViewProps {
  readonly preferences: DeviceNotificationFilterPreferences;
  readonly onCategoryChange: (category: NotificationCategory, next: boolean) => void;
  readonly onQuietHoursChange: (patch: Partial<QuietHours>) => void;
}

/**
 * Render-only. A malformed time input is simply not applied — `parseTimeOfDay` answers `null` for
 * anything that is not a valid 24-hour `HH:MM`, and this view never calls the patch callback with one.
 */
export function NotificationFilterSettingsView({
  preferences,
  onCategoryChange,
  onQuietHoursChange,
}: NotificationFilterSettingsViewProps) {
  const { categories, quietHours } = preferences;
  return (
    <section className="flex flex-col gap-2" aria-label="Notification filter">
      <p className="m-0 text-meta leading-base text-faint">{NOTIFICATION_FILTER_SCOPE_NOTE}</p>
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Show me</legend>
        {NOTIFICATION_CATEGORIES.map(category => (
          <Toggle
            key={category}
            checked={categories[category]}
            onChange={next => onCategoryChange(category, next)}
            label={NOTIFICATION_CATEGORY_COPY[category].label}
            description={NOTIFICATION_CATEGORY_COPY[category].description}
          />
        ))}
      </fieldset>
      <Toggle
        checked={quietHours.enabled}
        onChange={next => onQuietHoursChange({ enabled: next })}
        label="Quiet hours"
        description="Show nothing during a daily window, even for a kind that is switched on."
      />
      {quietHours.enabled && (
        <div className="flex flex-wrap items-center gap-3 rounded-control border border-border bg-surface-2 px-control-x py-2">
          <label className="flex min-h-[44px] items-center gap-2 text-ui text-fg">
            From
            <input
              type="time"
              value={formatTimeOfDay(quietHours.startMinute)}
              onChange={event => {
                const minute = parseTimeOfDay(event.target.value);
                if (minute !== null) onQuietHoursChange({ startMinute: minute });
              }}
              className="min-h-[44px] rounded-control border border-border bg-surface px-2 text-ui text-fg"
            />
          </label>
          <label className="flex min-h-[44px] items-center gap-2 text-ui text-fg">
            To
            <input
              type="time"
              value={formatTimeOfDay(quietHours.endMinute)}
              onChange={event => {
                const minute = parseTimeOfDay(event.target.value);
                if (minute !== null) onQuietHoursChange({ endMinute: minute });
              }}
              className="min-h-[44px] rounded-control border border-border bg-surface px-2 text-ui text-fg"
            />
          </label>
        </div>
      )}
    </section>
  );
}
