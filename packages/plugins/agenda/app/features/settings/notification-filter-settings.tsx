/**
 * THIS DEVICE'S notification filter — the owner-approved spec's "This device" pill.
 *
 * Every paired machine now sends every event (`packages/daemon/src/lib/push/service.ts`); this
 * screen is the only place left that decides what a reader actually sees: the five switches
 * (needs you, finished, failed, new device, PRs & CI) and quiet hours, all device-wide. Muting one machine alone is a
 * row of that machine's notification switch (Access's). All of it is local to this browser; nothing here is sent to any
 * daemon.
 *
 * LAYOUT (r10 S8): the five kinds are compact tiles in a 1 / 2 / 3 column grid (icon, name, one line, switch); quiet
 * hours is ONE row (its switch, and From / To inline while it is on). One surface per tile, no box in a box.
 */
import { BellRing, CircleAlert, CircleCheck, GitPullRequest, Moon, Smartphone } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  type DeviceNotificationFilterPreferences,
  formatTimeOfDay,
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CATEGORY_COPY,
  type NotificationCategory,
  parseTimeOfDay,
  type QuietHours,
} from '../../lib/notification-filter.ts';
import { SwitchGlyph, Toggle } from './toggle.tsx';

const NOTIFICATION_FILTER_INTRO = 'What this browser shows. Each machine’s own switch mutes it everywhere.';

const ICON_PROPS = { size: 18, strokeWidth: 1.75, focusable: false } as const;

/** One glyph per kind, and the one-line wording a tile shows (the full sentence stays on its hover and for assistive tech). */
const TILE: Readonly<Record<NotificationCategory, { readonly icon: ReactNode; readonly line: string }>> = {
  'needs-you': { icon: <BellRing {...ICON_PROPS} />, line: 'A session is waiting on you' },
  finished: { icon: <CircleCheck {...ICON_PROPS} />, line: 'A session completed' },
  failed: { icon: <CircleAlert {...ICON_PROPS} />, line: 'A session failed or stalled' },
  'new-device': { icon: <Smartphone {...ICON_PROPS} />, line: 'Another browser was paired' },
  'prs-ci': { icon: <GitPullRequest {...ICON_PROPS} />, line: 'CI, reviews and PR changes' },
};

export interface NotificationFilterSettingsViewProps {
  readonly preferences: DeviceNotificationFilterPreferences;
  readonly onCategoryChange: (category: NotificationCategory, next: boolean) => void;
  readonly onQuietHoursChange: (patch: Partial<QuietHours>) => void;
}

const TIME_INPUT_CLASS = 'min-h-[44px] rounded-control border border-border bg-surface px-2 text-ui text-fg';

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
    <section className="flex flex-col gap-4" aria-label="Notification filter">
      <p className="m-0 text-meta leading-base text-faint">{NOTIFICATION_FILTER_INTRO}</p>
      <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2 xl:grid-cols-3">
        <legend className="sr-only">Show me</legend>
        {NOTIFICATION_CATEGORIES.map(category => (
          <Toggle
            key={category}
            checked={categories[category]}
            onChange={next => onCategoryChange(category, next)}
            label={NOTIFICATION_CATEGORY_COPY[category].label}
            description={TILE[category].line}
            icon={TILE[category].icon}
            title={NOTIFICATION_CATEGORY_COPY[category].description}
          />
        ))}
      </fieldset>
      <div className="flex min-h-[56px] flex-wrap items-center gap-x-4 gap-y-2" data-quiet-hours-row="">
        <button
          type="button"
          role="switch"
          aria-checked={quietHours.enabled}
          title="Show nothing during a daily window, even for a kind that is switched on."
          onClick={() => onQuietHoursChange({ enabled: !quietHours.enabled })}
          className="flex min-h-[44px] items-center gap-3 rounded-control text-left"
        >
          <span aria-hidden="true" className={quietHours.enabled ? 'text-accent' : 'text-muted'}>
            <Moon {...ICON_PROPS} />
          </span>
          <span className="text-ui font-semibold text-fg">Quiet hours</span>
          <SwitchGlyph checked={quietHours.enabled} />
        </button>
        {quietHours.enabled && (
          <>
            <label className="flex min-h-[44px] items-center gap-2 text-ui text-fg">
              From
              <input
                type="time"
                value={formatTimeOfDay(quietHours.startMinute)}
                onChange={event => {
                  const minute = parseTimeOfDay(event.target.value);
                  if (minute !== null) onQuietHoursChange({ startMinute: minute });
                }}
                className={TIME_INPUT_CLASS}
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
                className={TIME_INPUT_CLASS}
              />
            </label>
          </>
        )}
      </div>
    </section>
  );
}
