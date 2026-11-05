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
import { SettingRow, SettingSwitch } from './setting-row.tsx';

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
  const timeInput = (key: 'startMinute' | 'endMinute', label: string) => (
    <label className="flex min-h-[44px] items-center gap-2 text-ui text-fg">
      {label}
      <input
        type="time"
        value={formatTimeOfDay(quietHours[key])}
        onChange={event => {
          const minute = parseTimeOfDay(event.target.value);
          if (minute !== null) onQuietHoursChange({ [key]: minute });
        }}
        className="min-h-[44px] rounded-control border border-border bg-surface px-2 text-ui text-fg"
      />
    </label>
  );
  return (
    <>
      <li className="px-panel pt-3 text-meta leading-base text-faint">{NOTIFICATION_FILTER_SCOPE_NOTE}</li>
      {NOTIFICATION_CATEGORIES.map(category => (
        <SettingRow
          key={category}
          name={NOTIFICATION_CATEGORY_COPY[category].label}
          hint={NOTIFICATION_CATEGORY_COPY[category].description}
          control={labelId => (
            <SettingSwitch
              checked={categories[category]}
              labelledBy={labelId}
              onChange={next => onCategoryChange(category, next)}
            />
          )}
        />
      ))}
      <SettingRow
        name="Quiet hours"
        hint="Show nothing during a daily window, even for a kind that is switched on."
        control={labelId => (
          <SettingSwitch
            checked={quietHours.enabled}
            labelledBy={labelId}
            onChange={next => onQuietHoursChange({ enabled: next })}
          />
        )}
      />
      {quietHours.enabled && (
        <li className="flex flex-wrap items-center gap-x-4 px-panel py-1">
          {timeInput('startMinute', 'From')}
          {timeInput('endMinute', 'To')}
        </li>
      )}
    </>
  );
}
