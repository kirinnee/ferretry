/**
 * The browser entry for the Agenda settings tab (r10 S8), over fake data: the REAL `NotificationFilterSettingsView` under a
 * stand-in page head (title + the scope chip), driven by local state.
 *
 *   ?theme=<family>-<mode>   ?quiet=on   quiet hours switched on, 22:00 to 07:00
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotificationFilterSettingsView } from '../../../../app/features/settings/notification-filter-settings.tsx';
import {
  DEFAULT_NOTIFICATION_FILTER_PREFERENCES,
  type DeviceNotificationFilterPreferences,
} from '../../../../app/lib/notification-filter.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const start: DeviceNotificationFilterPreferences =
  params.get('quiet') === 'on'
    ? { ...DEFAULT_NOTIFICATION_FILTER_PREFERENCES, quietHours: { enabled: true, startMinute: 1_320, endMinute: 420 } }
    : DEFAULT_NOTIFICATION_FILTER_PREFERENCES;

function Scene() {
  const [preferences, setPreferences] = useState(start);
  return (
    <main style={{ maxWidth: 1_100, padding: 16 }}>
      <h1 className="text-ui font-semibold">Agenda</h1>
      <p data-scope-chip="" className="text-meta text-muted">
        Only this browser
      </p>
      <NotificationFilterSettingsView
        preferences={preferences}
        onCategoryChange={(category, next) =>
          setPreferences(current => ({ ...current, categories: { ...current.categories, [category]: next } }))
        }
        onQuietHoursChange={patch =>
          setPreferences(current => ({ ...current, quietHours: { ...current.quietHours, ...patch } }))
        }
      />
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null) createRoot(root).render(<Scene />);
